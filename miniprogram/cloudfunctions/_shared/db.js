/**
 * cloudfunctions/_shared/db.js
 * 云开发公共层：SDK 初始化、身份校验、事务封装、错误码与统一返回。
 *
 * 上线版的几条硬约定（改代码前先看一眼）：
 *  1) 5 个集合权限全部设为「仅管理端可读写」，客户端不直连数据库，所有读写只从云函数发出；
 *  2) 身份一律取 cloud.getWXContext().OPENID，绝不信任客户端传上来的 openid；
 *  3) 时间字段统一存毫秒时间戳（number），避开 Date 在客户端/云端序列化不一致；
 *  4) 业务日期按北京时间（UTC+8）算：云函数运行环境是 UTC，直接 new Date() 会差 8 小时。
 */
var cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();
var _ = db.command;
var $ = db.command.aggregate;

/* ---------------- 常量 ---------------- */
var COLL = {
  ROOMS: 'rooms',
  MEMBERS: 'room_members',
  EXPENSES: 'expenses',
  SETTLE_LOGS: 'settle_logs',
  USAGE: 'usage'
};

var ERR = {
  NO_AUTH: 'NO_AUTH',
  NOT_MEMBER: 'NOT_MEMBER',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  INVALID: 'INVALID',
  QUOTA: 'QUOTA',
  INTERNAL: 'INTERNAL'
};

var MSG = {
  INTERNAL: '服务开小差了，请稍后重试',
  NO_AUTH: '没拿到你的登录身份，请退出小程序重进一次',
  NOT_MEMBER: '你还不是这个房间的成员',
  ROOM_NOT_FOUND: '房间不存在，或已经被解散',
  ROOM_FULL: '房间满了（最多 8 人）',
  INVALID: '参数不对'
};

var MAX_MEMBERS = 8;
/* 32 个字符：去掉易混淆的 0 O 1 I l */
var ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var ROOM_CODE_LEN = 6;
var TZ_OFFSET_MS = 8 * 3600 * 1000;

/* ---------------- 错误与返回 ---------------- */
/** 业务错误：统一被 createHandler 翻译成 { ok:false, code, message } */
function AppError(code, message) {
  this.name = 'AppError';
  this.code = code || ERR.INTERNAL;
  this.message = message || MSG.INTERNAL;
  this.isAppError = true;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function isAppError(e) {
  return !!(e && e.isAppError);
}

function ok(data) {
  return { ok: true, data: data === undefined ? null : data };
}

function fail(code, message) {
  return { ok: false, code: code || ERR.INTERNAL, message: message || MSG.INTERNAL };
}

/* ---------------- 时间（北京时间） ---------------- */
var pad2 = function (n) { return n < 10 ? '0' + n : String(n); };

function bjNow() {
  return new Date(Date.now() + TZ_OFFSET_MS);
}
/** 'YYYY-MM-DD'（北京时间） */
function bjDateStr(d) {
  var x = d || bjNow();
  return x.getUTCFullYear() + '-' + pad2(x.getUTCMonth() + 1) + '-' + pad2(x.getUTCDate());
}
/** 'YYYY-MM'（北京时间） */
function bjMonthStr(d) {
  return bjDateStr(d).slice(0, 7);
}
/** 'YYYYMMDD'（北京时间，配额/备份目录用） */
function bjDayKey(d) {
  return bjDateStr(d).replace(/-/g, '');
}

/* ---------------- 错误识别 ---------------- */
function errString(e) {
  if (!e) return '';
  var parts = [];
  if (e.errCode !== undefined && e.errCode !== null) parts.push(String(e.errCode));
  if (e.code !== undefined && e.code !== null && e.code !== e.errCode) parts.push(String(e.code));
  if (e.errMsg) parts.push(String(e.errMsg));
  if (e.message) parts.push(String(e.message));
  return parts.join(' ');
}

/** 集合还没建（部署时最常见）——单独识别，方便日志里给出明确提示 */
function isCollectionMissing(e) {
  return /-502005|COLLECTION_NOT_EXIST|collection not exist/i.test(errString(e));
}

function isDocMissing(e) {
  if (isCollectionMissing(e)) return false;
  return /-502004|DOCUMENT_NOT_EXIST|document not exist|document does not exist/i.test(errString(e));
}

/** 唯一索引冲突（幂等兜底会用到） */
function isDuplicateKey(e) {
  return /duplicate|E11000|-501001|已存在/i.test(errString(e));
}

/* ---------------- 身份 ---------------- */
function getWXContext() {
  try {
    return cloud.getWXContext() || {};
  } catch (e) {
    return {};
  }
}

function getOpenid() {
  return getWXContext().OPENID || '';
}

/* ---------------- 通用读写 ---------------- */
async function getDocOrNull(coll, id) {
  if (!id) return null;
  try {
    var res = await db.collection(coll).doc(id).get();
    return (res && res.data) || null;
  } catch (e) {
    if (isDocMissing(e)) return null;
    throw e;
  }
}

/** 事务封装：回调里只做 doc().get/update/add/set，别在事务里跑聚合 */
function runTx(fn) {
  return db.runTransaction(fn);
}

/** 写账后同步刷新房间活跃时间（失败只告警，不影响主流程） */
function touchRoom(roomId) {
  if (!roomId) return Promise.resolve();
  return db.collection(COLL.ROOMS).doc(roomId).update({ data: { updatedAt: Date.now() } })
    .catch(function (e) {
      console.warn('[touchRoom] ' + errString(e).slice(0, 160));
    });
}

/* ---------------- 成员 ---------------- */
/** 按 (roomId, openid) 找成员文档，不限状态（含已退出/pending） */
async function findMemberAny(roomId, openid) {
  if (!roomId || !openid) return null;
  var res = await db.collection(COLL.MEMBERS)
    .where({ roomId: roomId, openid: openid })
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

async function findActiveMember(roomId, openid) {
  var doc = await findMemberAny(roomId, openid);
  return doc && doc.status === 'active' ? doc : null;
}

/** 房间当前有效成员（按加入顺序），含待认领的 pending 成员 */
async function listActiveMembers(roomId) {
  var res = await db.collection(COLL.MEMBERS)
    .where({ roomId: roomId, status: 'active' })
    .orderBy('joinedAt', 'asc')
    .limit(100)
    .get();
  return (res.data || []);
}

async function activeMemberNames(roomId) {
  var list = await listActiveMembers(roomId);
  return list.map(function (m) { return m.name; });
}

/**
 * 每个入口的第一件事：是不是这个房间的人。
 * 房间不存在/已解散 → ROOM_NOT_FOUND；不是成员 → NOT_MEMBER。
 */
async function assertMember(roomId, openid) {
  var room = await getDocOrNull(COLL.ROOMS, roomId);
  if (!room || room.status !== 'active') {
    throw new AppError(ERR.ROOM_NOT_FOUND, MSG.ROOM_NOT_FOUND);
  }
  var member = await findMemberAny(roomId, openid);
  if (!member || member.status !== 'active') {
    throw new AppError(ERR.NOT_MEMBER, MSG.NOT_MEMBER);
  }
  return { room: room, member: member };
}

/**
 * 房间作用域解析：优先用客户端传的 roomId（并校验成员身份）；
 * 没传就落到「我当前所在的房间」——保证任意入口都不会跨房间读写。
 */
async function resolveRoom(openid, roomId) {
  if (roomId) return await assertMember(String(roomId), openid);
  var res = await db.collection(COLL.MEMBERS)
    .where({ openid: openid, status: 'active' })
    .orderBy('joinedAt', 'desc')
    .limit(10)
    .get();
  var list = res.data || [];
  for (var i = 0; i < list.length; i++) {
    var room = await getDocOrNull(COLL.ROOMS, list[i].roomId);
    if (room && room.status === 'active') {
      return { room: room, member: list[i] };
    }
  }
  throw new AppError(ERR.NOT_MEMBER, '你还没有加入任何房间，先创建或加入一个吧');
}

/* ---------------- 房间码 / 建房 ---------------- */
function genRoomCode() {
  var out = '';
  for (var i = 0; i < ROOM_CODE_LEN; i++) {
    out += ROOM_ALPHABET.charAt(Math.floor(Math.random() * ROOM_ALPHABET.length));
  }
  return out;
}

async function isCodeTaken(code) {
  try {
    var res = await db.collection(COLL.ROOMS).where({ code: code }).count();
    return !!(res && res.total);
  } catch (e) {
    /* 集合刚建/统计失败时按「没占用」处理，后面还有唯一索引兜底 */
    return false;
  }
}

/** 前端统一用的房间视图（不暴露 ownerOpenid 等敏感字段） */
function roomView(room, role) {
  if (!room) return null;
  return {
    id: room._id,
    code: room.code,
    name: room.name,
    role: role || '',
    memberCount: Number(room.memberCount) || 0,
    status: room.status,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

function memberView(member, openid) {
  if (!member) return null;
  return {
    name: member.name,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt,
    isMe: member.openid === openid,
    pending: !!member.pending
  };
}

/**
 * 建房：rooms + room_members(owner) 一起落库，最多重试 5 次房间码。
 * pendingNames：迁移本机账本时，把还没进来的老成员先建成「待认领」成员，
 * 这样历史账目的 payer/participants 仍然是本房间成员；对方以后加入时按名字认领这个位子（不占新名额）。
 */
async function createRoom(opts) {
  var name = opts.name;
  var ownerOpenid = opts.ownerOpenid;
  var ownerName = opts.ownerName;
  var pendingNames = opts.pendingNames || [];
  var now = Date.now();

  for (var attempt = 0; attempt < 5; attempt++) {
    var code = genRoomCode();
    if (await isCodeTaken(code)) continue;

    var memberCount = 1 + pendingNames.length;
    var roomData = {
      code: code,
      name: name,
      ownerOpenid: ownerOpenid,
      status: 'active',
      memberCount: memberCount,
      createdAt: now,
      updatedAt: now
    };
    try {
      var roomId = await runTx(async function (t) {
        var added = await t.collection(COLL.ROOMS).add({ data: roomData });
        var id = added && (added._id || added.id);
        await t.collection(COLL.MEMBERS).add({
          data: {
            roomId: id,
            openid: ownerOpenid,
            name: ownerName,
            role: 'owner',
            status: 'active',
            pending: false,
            avatarFileID: '',
            joinedAt: now
          }
        });
        for (var i = 0; i < pendingNames.length; i++) {
          await t.collection(COLL.MEMBERS).add({
            data: {
              roomId: id,
              openid: 'pending:' + id + ':' + i,
              name: pendingNames[i],
              role: 'member',
              status: 'active',
              pending: true,
              avatarFileID: '',
              joinedAt: now
            }
          });
        }
        return id;
      });
      return { roomId: roomId, code: code, name: name, memberCount: memberCount };
    } catch (e) {
      if (isDuplicateKey(e)) continue; // 撞码：换个码再来
      throw e;
    }
  }
  throw new AppError(ERR.INTERNAL, '房间码生成失败了，请重试一次');
}

/* ---------------- 统一入口 ---------------- */
/**
 * 每个云函数 index.js 只写这一行：exports.main = createHandler('expense', handlers)
 * 统一处理：action 分发、身份校验、payload 校验、错误码翻译、日志脱敏。
 */
function createHandler(fnName, handlers) {
  return async function main(event, context) {
    var action = '';
    try {
      action = String((event && event.action) || '').trim();
      var payload = (event && event.payload) || {};
      var openid = getOpenid();

      if (!openid) return fail(ERR.NO_AUTH, MSG.NO_AUTH);
      if (!action) return fail(ERR.INVALID, '缺少 action');
      var fn = handlers[action];
      if (typeof fn !== 'function') return fail(ERR.INVALID, '不支持的操作：' + action.slice(0, 40));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return fail(ERR.INVALID, 'payload 必须是一个对象');
      }

      var data = await fn({
        openid: openid,
        payload: payload,
        action: action,
        event: event,
        context: context
      });
      return ok(data);
    } catch (e) {
      return toFail(fnName, action, e);
    }
  };
}

function toFail(fnName, action, e) {
  if (isAppError(e)) return fail(e.code, e.message);

  if (isCollectionMissing(e)) {
    console.error('[' + fnName + '][' + action + '] 数据库集合不存在：请先在云开发控制台建好 rooms / room_members / expenses / settle_logs / usage');
    /* 给用户一句能照着做的话，别只说"服务开小差了" */
    return fail(ERR.INVALID, '云端数据库还没建好（缺少集合）。请按 docs/新手操作手册.md 第 3 步，在云开发控制台建好 rooms / room_members / expenses / settle_logs / usage 这五个集合');
  }
  if (isDuplicateKey(e)) {
    /* 唯一索引兜底：并发写入同一条记录时给个能看懂的提示，别抛 INTERNAL */
    return fail(ERR.INVALID, '这条记录已经存在了，刷新一下再试');
  }

  /* 只打函数名/action/简要堆栈，绝不打印完整入参（可能含小票文字、Key） */
  var brief = errString(e).slice(0, 300);
  var stack = e && e.stack ? String(e.stack).slice(0, 800) : '';
  console.error('[' + fnName + '][' + action + '] ' + brief + (stack ? '\n' + stack : ''));
  return fail(ERR.INTERNAL, MSG.INTERNAL);
}

module.exports = {
  cloud: cloud,
  db: db,
  _: _,
  $: $,
  COLL: COLL,
  ERR: ERR,
  MSG: MSG,
  MAX_MEMBERS: MAX_MEMBERS,
  ROOM_ALPHABET: ROOM_ALPHABET,
  ROOM_CODE_LEN: ROOM_CODE_LEN,
  AppError: AppError,
  isAppError: isAppError,
  isCollectionMissing: isCollectionMissing,
  isDocMissing: isDocMissing,
  isDuplicateKey: isDuplicateKey,
  errString: errString,
  ok: ok,
  fail: fail,
  getWXContext: getWXContext,
  getOpenid: getOpenid,
  bjNow: bjNow,
  bjDateStr: bjDateStr,
  bjMonthStr: bjMonthStr,
  bjDayKey: bjDayKey,
  getDocOrNull: getDocOrNull,
  runTx: runTx,
  touchRoom: touchRoom,
  findMemberAny: findMemberAny,
  findActiveMember: findActiveMember,
  listActiveMembers: listActiveMembers,
  activeMemberNames: activeMemberNames,
  assertMember: assertMember,
  resolveRoom: resolveRoom,
  genRoomCode: genRoomCode,
  isCodeTaken: isCodeTaken,
  roomView: roomView,
  memberView: memberView,
  createRoom: createRoom,
  createHandler: createHandler
};
