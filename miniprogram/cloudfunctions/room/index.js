/**
 * cloudfunctions/room/index.js
 * 房间：建房 / 加入 / 退出 / 改名 / 解散 / 成员 / 改档案 / 换房间码 / 我的房间列表
 *
 * 业务规则（改动前请一起看）：
 *  - 房间 2–8 人；memberCount 必须与 room_members 里 status:'active' 的条数一致，都在事务里维护；
 *  - 加入时房间必须 status:'active' 且 memberCount < 8；已经在房间里则直接返回（幂等）；
 *  - 退出只把成员置 status:'quit'，历史账目里的姓名保持不变（否则旧账会算错人）；
 *  - 解散是软删除 status:'closed'，账目与成员记录都留着做审计；
 *  - 房主退出时把房主转给最早加入的其他成员；没有真人可接手就关房。
 */
var fs = require('fs');
var path = require('path');

/* 共享模块：仓库里在 ../_shared；上传云函数时若已复制成函数内 shared/，则走 ./shared（见 README「部署步骤」） */
var SHARED = fs.existsSync(path.join(__dirname, '..', '_shared', 'db.js')) ? '../_shared/' : './shared/';
var db = require(SHARED + 'db.js');
var V = require(SHARED + 'validate.js');
var F = require(SHARED + 'finance.js');

/* ---------------- 小工具 ---------------- */
function requireOwner(member) {
  if (!member || member.role !== 'owner') {
    throw new db.AppError(db.ERR.INVALID, '只有房主可以执行这个操作');
  }
}

/** 我上一次用的名字（换房间时沿用，避免每间房都要重新起名） */
async function lastMemberName(openid) {
  try {
    var res = await db.db.collection(db.COLL.MEMBERS)
      .where({ openid: openid, status: 'active', pending: false })
      .orderBy('joinedAt', 'desc')
      .limit(1)
      .get();
    var doc = (res.data && res.data[0]) || null;
    return doc ? doc.name : '';
  } catch (e) {
    return '';
  }
}

/**
 * 认领迁移进来的「待认领」成员位：同名即认领，memberCount 不变。
 * 用条件更新（pending:true）避免两个人同时认领同一个位子。
 */
async function claimPending(roomId, name, openid) {
  var res = await db.db.collection(db.COLL.MEMBERS)
    .where({ roomId: roomId, name: name, status: 'active', pending: true })
    .limit(1)
    .get();
  var doc = (res.data && res.data[0]) || null;
  if (!doc) return false;
  try {
    var upd = await db.db.collection(db.COLL.MEMBERS)
      .where({ _id: doc._id, pending: true })
      .update({ data: { openid: openid, pending: false, joinedAt: Date.now() } });
    return !!((upd && upd.stats && upd.stats.updated));
  } catch (e) {
    if (db.isDuplicateKey(e)) return false;
    throw e;
  }
}

/* ---------------- 改名时同步历史账目 ---------------- */
function remapArrayNames(arr, oldName, newName) {
  return (arr || []).map(function (x) {
    if (!x || typeof x !== 'object' || x.name !== oldName) return x;
    var copy = Object.assign({}, x);
    copy.name = newName;
    return copy;
  });
}

function remapObjectKeys(obj, oldName, newName) {
  if (!obj || typeof obj !== 'object') return obj;
  var out = {};
  Object.keys(obj).forEach(function (k) {
    out[k === oldName ? newName : k] = obj[k];
  });
  return out;
}

/** 把一笔账里的旧名字全部换成新名字（金额与分摊比例不变，所以不用重算 shares） */
function mapExpenseNames(doc, oldName, newName) {
  var patch = { updatedAt: Date.now() };
  if (doc.payer === oldName) patch.payer = newName;
  patch.participants = remapArrayNames(doc.participants, oldName, newName);
  patch.shares = remapArrayNames(doc.shares, oldName, newName);
  patch.settled = remapObjectKeys(doc.settled, oldName, newName);
  patch.settleMeta = remapObjectKeys(doc.settleMeta, oldName, newName);
  return patch;
}

/**
 * 改昵称会把历史账目里的姓名一起改写，否则余额会断成两个人。
 * 量太大（>300 笔）直接拒绝：这种改写不该在一次云函数调用里硬扛。
 */
async function renameExpenseRefs(roomId, oldName, newName) {
  var cond = db._.and([
    { roomId: roomId },
    db._.or([{ payer: oldName }, { 'participants.name': oldName }])
  ]);
  var cntRes = await db.db.collection(db.COLL.EXPENSES).where(cond).count();
  var total = (cntRes && cntRes.total) || 0;
  if (total > 300) {
    throw new db.AppError(db.ERR.INVALID, '房间里已经有 ' + total + ' 笔账目，改名后历史记录需要批量改写，请保留原来的称呼');
  }
  if (!total) return { updated: 0, total: 0 };

  var updated = 0;
  for (var page = 0; page < 4; page++) {
    var res = await db.db.collection(db.COLL.EXPENSES).where(cond).limit(100).get();
    var list = (res && res.data) || [];
    if (!list.length) break;
    for (var i = 0; i < list.length; i += 10) {
      var chunk = list.slice(i, i + 10);
      await Promise.all(chunk.map(function (doc) {
        return db.db.collection(db.COLL.EXPENSES).doc(doc._id)
          .update({ data: mapExpenseNames(doc, oldName, newName) })
          .then(function () { updated++; })
          .catch(function (e) {
            /* 单条失败不阻断整体，剩下的用户可以再改一次（改名是幂等映射） */
            console.warn('[room][rename] ' + db.errString(e).slice(0, 160));
          });
      }));
    }
    if (list.length < 100) break;
  }
  return { updated: updated, total: total };
}

/* ---------------- create ---------------- */
async function create(ctx) {
  var p = ctx.payload || {};
  var name = V.roomName(p.name);

  var memberName = V.tryPersonName(p.memberName);
  if (!memberName) memberName = (await lastMemberName(ctx.openid)) || '寝室长';

  var created = await db.createRoom({
    name: name,
    ownerOpenid: ctx.openid,
    ownerName: memberName,
    pendingNames: []
  });

  var room = await db.getDocOrNull(db.COLL.ROOMS, created.roomId);
  var member = await db.findActiveMember(created.roomId, ctx.openid);
  return { room: db.roomView(room, member ? member.role : 'owner') };
}

/* ---------------- join ---------------- */
async function join(ctx) {
  var p = ctx.payload || {};
  var code = V.roomCode(p.code);
  var wantName = V.tryPersonName(p.name);

  var found = await db.db.collection(db.COLL.ROOMS).where({ code: code }).limit(1).get();
  var room = (found.data && found.data[0]) || null;
  if (!room || room.status !== 'active') {
    throw new db.AppError(db.ERR.ROOM_NOT_FOUND, '房间码不对，或者房间已经解散');
  }

  var mine = await db.findMemberAny(room._id, ctx.openid);
  if (mine && mine.status === 'active') {
    /* 已经在房间里：幂等返回，不重复加人 */
    return { room: db.roomView(room, mine.role), rejoined: true, claimed: false };
  }

  var name = wantName || (await lastMemberName(ctx.openid)) ||
    ('室友' + ((Number(room.memberCount) || 0) + 1));

  /* 迁移进来的老成员（pending）：同名直接认领位子，不占新名额 */
  if (!mine) {
    var claimed = await claimPending(room._id, name, ctx.openid);
    if (claimed) {
      var m1 = await db.findActiveMember(room._id, ctx.openid);
      return { room: db.roomView(room, m1 ? m1.role : 'member'), rejoined: false, claimed: true };
    }
  }

  var now = Date.now();
  var out = await db.runTx(async function (t) {
    var snap = await t.collection(db.COLL.ROOMS).doc(room._id).get();
    var live = (snap && snap.data) || null;
    if (!live || live.status !== 'active') {
      return { ok: false, code: db.ERR.ROOM_NOT_FOUND, message: '房间已经解散' };
    }
    var cnt = Number(live.memberCount) || 0;
    if (cnt >= db.MAX_MEMBERS) {
      return { ok: false, code: db.ERR.ROOM_FULL, message: db.MSG.ROOM_FULL };
    }
    if (mine && mine.status === 'quit') {
      /* 之前退出过：复用同一条成员记录（(roomId, openid) 唯一） */
      await t.collection(db.COLL.MEMBERS).doc(mine._id).update({
        data: { status: 'active', name: name, role: 'member', pending: false, joinedAt: now }
      });
    } else {
      await t.collection(db.COLL.MEMBERS).add({
        data: {
          roomId: room._id,
          openid: ctx.openid,
          name: name,
          role: 'member',
          status: 'active',
          pending: false,
          avatarFileID: '',
          joinedAt: now
        }
      });
    }
    await t.collection(db.COLL.ROOMS).doc(room._id).update({
      data: { memberCount: cnt + 1, updatedAt: now }
    });
    return { ok: true };
  });
  if (!out.ok) throw new db.AppError(out.code, out.message);

  var freshRoom = await db.getDocOrNull(db.COLL.ROOMS, room._id);
  var m2 = await db.findActiveMember(room._id, ctx.openid);
  return { room: db.roomView(freshRoom, m2 ? m2.role : 'member'), rejoined: false, claimed: false };
}

/* ---------------- leave ---------------- */
async function leave(ctx) {
  var target = await db.resolveRoom(ctx.openid, (ctx.payload || {}).roomId);
  var room = target.room;
  var me = target.member;

  var active = await db.listActiveMembers(room._id);
  var realOthers = active.filter(function (m) {
    return m.openid !== ctx.openid && !m.pending;
  });
  var now = Date.now();

  var out = await db.runTx(async function (t) {
    var snap = await t.collection(db.COLL.ROOMS).doc(room._id).get();
    var live = (snap && snap.data) || null;
    if (!live || live.status !== 'active') {
      return { ok: false, code: db.ERR.ROOM_NOT_FOUND, message: '房间已经解散' };
    }
    var cnt = Number(live.memberCount) || 0;
    var nextCount = Math.max(0, cnt - 1);

    /* 最后一个人走了，或者房主走了但只剩待认领成员 → 关房（软删除，账目保留） */
    if (nextCount === 0 || (me.role === 'owner' && !realOthers.length)) {
      await t.collection(db.COLL.MEMBERS).doc(me._id).update({
        data: { status: 'quit', role: 'member', quitAt: now }
      });
      await t.collection(db.COLL.ROOMS).doc(room._id).update({
        data: { status: 'closed', memberCount: Math.max(0, nextCount), updatedAt: now }
      });
      return { ok: true, closed: true, memberCount: Math.max(0, nextCount), transferTo: '' };
    }

    var roomPatch = { memberCount: nextCount, updatedAt: now };
    var transferTo = '';
    if (me.role === 'owner') {
      var next = realOthers[0];
      await t.collection(db.COLL.MEMBERS).doc(next._id).update({ data: { role: 'owner' } });
      roomPatch.ownerOpenid = next.openid;
      transferTo = next.name;
    }
    await t.collection(db.COLL.MEMBERS).doc(me._id).update({
      data: { status: 'quit', role: 'member', quitAt: now }
    });
    await t.collection(db.COLL.ROOMS).doc(room._id).update({ data: roomPatch });
    return { ok: true, closed: false, memberCount: nextCount, transferTo: transferTo };
  });
  if (!out.ok) throw new db.AppError(out.code, out.message);

  return { left: true, roomClosed: !!out.closed, memberCount: out.memberCount, transferTo: out.transferTo || '' };
}

/* ---------------- rename / dissolve ---------------- */
async function rename(ctx) {
  var name = V.roomName((ctx.payload || {}).name);
  var target = await db.resolveRoom(ctx.openid, (ctx.payload || {}).roomId);
  requireOwner(target.member);

  await db.db.collection(db.COLL.ROOMS).doc(target.room._id)
    .update({ data: { name: name, updatedAt: Date.now() } });
  var fresh = await db.getDocOrNull(db.COLL.ROOMS, target.room._id);
  return { room: db.roomView(fresh, target.member.role) };
}

async function dissolve(ctx) {
  var target = await db.resolveRoom(ctx.openid, (ctx.payload || {}).roomId);
  requireOwner(target.member);

  await db.db.collection(db.COLL.ROOMS).doc(target.room._id)
    .update({ data: { status: 'closed', updatedAt: Date.now() } });
  /* 成员与账目都不删：软删除，便于对账与申诉 */
  return { closed: true, code: target.room.code };
}

/* ---------------- members ---------------- */
async function members(ctx) {
  var target = await db.resolveRoom(ctx.openid, (ctx.payload || {}).roomId);
  var list = await db.listActiveMembers(target.room._id);
  return {
    room: db.roomView(target.room, target.member.role),
    me: db.memberView(target.member, ctx.openid),
    members: list.map(function (m) { return db.memberView(m, ctx.openid); })
  };
}

/* ---------------- updateProfile ---------------- */
async function updateProfile(ctx) {
  var p = ctx.payload || {};
  var target = await db.resolveRoom(ctx.openid, p.roomId);
  var me = target.member;

  var patch = {};
  if (p.avatarFileID !== undefined) patch.avatarFileID = V.avatarFileID(p.avatarFileID);

  var renamed = null;
  var newName = (p.name === undefined || p.name === null) ? '' : V.personName(p.name);
  if (newName && newName !== me.name) {
    var dupRes = await db.db.collection(db.COLL.MEMBERS)
      .where({ roomId: target.room._id, name: newName, status: 'active' })
      .limit(1)
      .get();
    var dup = (dupRes.data && dupRes.data[0]) || null;
    if (dup && dup._id !== me._id) {
      throw new db.AppError(db.ERR.INVALID, '房间里已经有叫「' + newName + '」的成员了');
    }
    /* 先改写历史账目，成功后再改成员名，避免中途失败导致对不上 */
    renamed = await renameExpenseRefs(target.room._id, me.name, newName);
    patch.name = newName;
  }

  if (!Object.keys(patch).length) {
    return { profile: { name: me.name, avatarFileID: me.avatarFileID || '' }, renamed: null };
  }

  await db.db.collection(db.COLL.MEMBERS).doc(me._id).update({ data: patch });
  return {
    profile: {
      name: patch.name || me.name,
      avatarFileID: patch.avatarFileID !== undefined ? patch.avatarFileID : (me.avatarFileID || '')
    },
    renamed: renamed
  };
}

/* ---------------- resetCode ---------------- */
async function resetCode(ctx) {
  var target = await db.resolveRoom(ctx.openid, (ctx.payload || {}).roomId);
  requireOwner(target.member);

  for (var i = 0; i < 5; i++) {
    var code = db.genRoomCode();
    if (await db.isCodeTaken(code)) continue;
    try {
      await db.db.collection(db.COLL.ROOMS).doc(target.room._id)
        .update({ data: { code: code, updatedAt: Date.now() } });
      var fresh = await db.getDocOrNull(db.COLL.ROOMS, target.room._id);
      return { code: code, room: db.roomView(fresh, target.member.role) };
    } catch (e) {
      if (db.isDuplicateKey(e)) continue;
      throw e;
    }
  }
  throw new db.AppError(db.ERR.INTERNAL, '房间码生成失败了，请再试一次');
}

/* ---------------- summary（我加入的房间列表） ---------------- */
async function roomStats(roomId) {
  var count = 0;
  var total = 0;
  try {
    var c = await db.db.collection(db.COLL.EXPENSES).where({ roomId: roomId, revoked: false }).count();
    count = (c && c.total) || 0;
  } catch (e) {
    count = 0;
  }
  try {
    var agg = await db.db.collection(db.COLL.EXPENSES).aggregate()
      .match({ roomId: roomId, revoked: false })
      .group({ _id: null, total: db.$.sum('$amount') })
      .end();
    var rows = (agg && agg.list) || [];
    total = rows.length ? F.num(rows[0].total) : 0;
  } catch (e) {
    total = 0;
  }
  return { count: count, total: total };
}

async function summary(ctx) {
  var res = await db.db.collection(db.COLL.MEMBERS)
    .where({ openid: ctx.openid, status: 'active' })
    .orderBy('joinedAt', 'desc')
    .limit(20)
    .get();
  var list = res.data || [];

  var rooms = [];
  for (var i = 0; i < list.length; i++) {
    var room = await db.getDocOrNull(db.COLL.ROOMS, list[i].roomId);
    if (!room || room.status !== 'active') continue;
    var stats = await roomStats(room._id);
    rooms.push({
      id: room._id,
      code: room.code,
      name: room.name,
      role: list[i].role,
      memberCount: Number(room.memberCount) || 0,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      expenseCount: stats.count,
      total: stats.total
    });
  }
  return { rooms: rooms };
}

/**
 * 房主预留一个成员位（不占真人名额，等对方用同名加入时认领）
 * 用途：室友还没进小程序时，先把名字占上，记账时就能直接分摊给他。
 */
async function addMember(ctx) {
  var p = ctx.payload || {};
  var target = await db.resolveRoom(ctx.openid, p.roomId);
  if (target.member.role !== 'owner') throw new db.AppError(db.ERR.NO_AUTH, '只有房主能添加成员');

  var name = V.personName(p.name);
  var roomId = target.room._id;

  var dup = await db.db.collection(db.COLL.MEMBERS)
    .where({ roomId: roomId, name: name, status: 'active' })
    .limit(1)
    .get();
  if ((dup.data || []).length) throw new db.AppError(db.ERR.INVALID, '已经有同名的室友了：' + name);

  var room = await db.getDocOrNull(db.COLL.ROOMS, roomId);
  if (!room || room.status !== 'active') throw new db.AppError(db.ERR.ROOM_NOT_FOUND, '房间不存在或已解散');
  if ((Number(room.memberCount) || 0) >= F.MAX_MEMBERS) {
    throw new db.AppError(db.ERR.ROOM_FULL, '一个房间最多 ' + F.MAX_MEMBERS + ' 人');
  }

  var now = Date.now();
  await db.runTx(async function (t) {
    await t.collection(db.COLL.MEMBERS).add({
      data: {
        roomId: roomId,
        openid: 'pending:' + roomId + ':' + now + ':' + Math.random().toString(36).slice(2, 6),
        name: name,
        role: 'member',
        status: 'active',
        pending: true,
        avatarFileID: '',
        joinedAt: now
      }
    });
    await t.collection(db.COLL.ROOMS).doc(roomId).update({
      data: { memberCount: db._.inc(1), updatedAt: now }
    });
  });

  return { name: name };
}

/**
 * 房主移除成员（软删除 status:'quit'；历史账目里的姓名保持不变，余额里显示"已退出"）
 */
async function removeMember(ctx) {
  var p = ctx.payload || {};
  var target = await db.resolveRoom(ctx.openid, p.roomId);
  if (target.member.role !== 'owner') throw new db.AppError(db.ERR.NO_AUTH, '只有房主能移除成员');

  var name = V.personName(p.name);
  if (name === target.member.name) throw new db.AppError(db.ERR.INVALID, '你自己要退出的话，请用「退出房间」');

  var roomId = target.room._id;
  var res = await db.db.collection(db.COLL.MEMBERS)
    .where({ roomId: roomId, name: name, status: 'active' })
    .limit(1)
    .get();
  var doc = (res.data && res.data[0]) || null;
  if (!doc) throw new db.AppError(db.ERR.INVALID, '找不到这位成员：' + name);

  var now = Date.now();
  await db.runTx(async function (t) {
    await t.collection(db.COLL.MEMBERS).doc(doc._id).update({
      data: { status: 'quit', pending: false, leftAt: now }
    });
    await t.collection(db.COLL.ROOMS).doc(roomId).update({
      data: { memberCount: db._.inc(-1), updatedAt: now }
    });
  });

  return { name: name };
}

exports.main = db.createHandler('room', {
  create: create,
  join: join,
  leave: leave,
  rename: rename,
  dissolve: dissolve,
  members: members,
  updateProfile: updateProfile,
  resetCode: resetCode,
  summary: summary,
  addMember: addMember,
  removeMember: removeMember
});
