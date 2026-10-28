/**
 * cloudfunctions/login/index.js
 * 登录态与「本机账本迁移」
 *
 * actions:
 *   whoami      → 我是谁、我在哪个房间
 *   importLocal → 把本机（qinzhang_room_<CODE>）的账本搬进云端新房间
 */
var fs = require('fs');
var path = require('path');

/* 共享模块：仓库里在 ../_shared；上传云函数时若已复制成函数内 shared/，则走 ./shared（见 README「部署步骤」） */
var SHARED = fs.existsSync(path.join(__dirname, '..', '_shared', 'db.js')) ? '../_shared/' : './shared/';
var db = require(SHARED + 'db.js');
var V = require(SHARED + 'validate.js');
var F = require(SHARED + 'finance.js');

/* ---------------- whoami ---------------- */
/**
 * 按 openid 在 room_members 里找 active 成员关系，返回身份 + 当前房间 + 本人档案。
 * 没有房间时 room/profile 都是 null，客户端据此引导「创建 / 加入」。
 */
async function whoami(ctx) {
  var openid = ctx.openid;

  var res = await db.db.collection(db.COLL.MEMBERS)
    .where({ openid: openid, status: 'active' })
    .orderBy('joinedAt', 'desc')
    .limit(10)
    .get();
  var list = (res && res.data) || [];

  for (var i = 0; i < list.length; i++) {
    var member = list[i];
    var room = await db.getDocOrNull(db.COLL.ROOMS, member.roomId);
    if (room && room.status === 'active') {
      return {
        openid: openid,
        room: { id: room._id, code: room.code, name: room.name, role: member.role },
        profile: { name: member.name, avatarFileID: member.avatarFileID || '' }
      };
    }
  }

  return { openid: openid, room: null, profile: null };
}

/* ---------------- importLocal ---------------- */
/** 把本机账本里出现的名字补进成员名单（最多 8 人，第一个人是当前用户） */
function collectNames(members, expenses) {
  var names = [];
  var i;
  for (i = 0; i < members.length && names.length < db.MAX_MEMBERS; i++) {
    var nm = V.tryPersonName(members[i]);
    if (nm && names.indexOf(nm) < 0) names.push(nm);
  }
  for (i = 0; i < expenses.length && names.length < db.MAX_MEMBERS; i++) {
    var e = expenses[i];
    if (!e || typeof e !== 'object') continue;
    var maybe = [e.payer];
    var parts = Array.isArray(e.participants) ? e.participants : [];
    for (var k = 0; k < parts.length; k++) {
      maybe.push(parts[k] && typeof parts[k] === 'object' ? parts[k].name : parts[k]);
    }
    for (var q = 0; q < maybe.length; q++) {
      if (names.length >= db.MAX_MEMBERS) break;
      var n2 = V.tryPersonName(maybe[q]);
      if (n2 && names.indexOf(n2) < 0) names.push(n2);
    }
  }
  return names;
}

/** 把本机一笔账转成云端文档；不合法就返回 null（计入 skipped） */
function toExpenseDoc(raw, x, opts) {
  try {
    if (!raw || typeof raw !== 'object') return null;

    var amount = V.amount(raw.amount);
    var date = V.tryDateStr(raw.date) || db.bjDateStr();
    var item = V.cleanText(raw.item, 40) || '导入的账目';
    var payer = V.tryPersonName(raw.payer) || opts.ownerName;
    if (opts.names.indexOf(payer) < 0) return null;

    /* 参与人只保留本房间成员：第 8 人以后的陌生名字会被丢掉，避免分摊校验失败 */
    var rawParts = Array.isArray(raw.participants) ? raw.participants : [];
    var parts = [];
    var seen = {};
    for (var j = 0; j < rawParts.length; j++) {
      var src = rawParts[j];
      var pn = V.tryPersonName(src && typeof src === 'object' ? src.name : src);
      if (!pn || opts.names.indexOf(pn) < 0 || seen[pn]) continue;
      seen[pn] = true;
      var w = 1;
      if (src && typeof src === 'object' && src.weight !== undefined && src.weight !== null) {
        w = Number(src.weight);
        if (!isFinite(w) || w <= 0) w = 1;
      }
      parts.push({ name: pn, weight: Math.round(w * 100) / 100 });
    }
    if (!parts.length) return null;

    var rawSettled = (raw.settled && typeof raw.settled === 'object') ? raw.settled : {};
    var settled = {};
    for (var s = 0; s < parts.length; s++) {
      settled[parts[s].name] = parts[s].name === payer ? true : rawSettled[parts[s].name] === true;
    }

    var localId = (raw.id === undefined || raw.id === null || raw.id === '') ? ('i' + x) : String(raw.id);
    var cid = ('local_' + localId).slice(0, 64);
    if (!/^[A-Za-z0-9_\-:.]+$/.test(cid)) cid = 'local_' + x;
    if (opts.seenClient[cid]) cid = ('local_' + localId + '_' + x).slice(0, 64);
    opts.seenClient[cid] = true;

    var receipt = null;
    try {
      receipt = V.receipt(raw.receipt);
    } catch (err) {
      receipt = null; // 小票数据坏了不影响账目迁移
    }

    return {
      roomId: opts.roomId,
      clientId: cid,
      date: date,
      item: item,
      category: (F.CATEGORIES.indexOf(String(raw.category || '')) >= 0 ? String(raw.category) : F.guessCategory(item)),
      amount: amount,
      payer: payer,
      mode: raw.mode === 'days' ? 'days' : 'equal',
      participants: parts,
      /* 分摊一律服务端重算，不采用本机存下来的 shares */
      shares: F.computeShares(amount, parts),
      settled: settled,
      settleMeta: {},
      source: raw.source === 'receipt' ? 'receipt' : 'nl',
      receipt: receipt,
      raw: V.rawText(raw.raw || '（从本机账本迁移）'),
      revoked: false,
      createdBy: opts.openid,
      updatedBy: opts.openid,
      createdAt: opts.now - (opts.total - x),
      updatedAt: opts.now
    };
  } catch (e) {
    return null;
  }
}

/**
 * 迁移本机账本：
 *  - 新建房间，当前用户是 owner，姓名取 members[0]；
 *  - 其余成员先建成「待认领」成员（pending），保证历史账目的 payer/participants 仍是本房间成员；
 *  - 账目 clientId 用 local_<本机 id>，同一条不会重复入账。
 */
async function importLocal(ctx) {
  var p = ctx.payload || {};
  var openid = ctx.openid;

  var label = V.cleanText(p.label, 16) || '我的寝室';
  if (label.length < 2) label = '我的寝室';

  var rawMembers = Array.isArray(p.members) ? p.members : [];
  var expenses = Array.isArray(p.expenses) ? p.expenses : [];

  if (expenses.length > 500) {
    throw new db.AppError(db.ERR.INVALID, '一次最多迁移 500 笔账目，请分批导入');
  }

  var names = collectNames(rawMembers, expenses);
  if (!names.length) {
    throw new db.AppError(db.ERR.INVALID, '没读到寝室成员名单，请先在小程序里把成员填好再迁移');
  }

  var ownerName = names[0];
  var created = await db.createRoom({
    name: label,
    ownerOpenid: openid,
    ownerName: ownerName,
    pendingNames: names.slice(1)
  });

  var now = Date.now();
  var opts = {
    roomId: created.roomId,
    names: names,
    ownerName: ownerName,
    openid: openid,
    now: now,
    total: expenses.length,
    seenClient: {}
  };

  var docs = [];
  var skipped = 0;
  for (var x = 0; x < expenses.length; x++) {
    var doc = toExpenseDoc(expenses[x], x, opts);
    if (!doc) {
      skipped++;
      continue;
    }
    docs.push(doc);
  }

  /* 分批写入：单批 20 条并发，既快又不至于把云函数打爆 */
  var imported = 0;
  for (var s = 0; s < docs.length; s += 20) {
    var chunk = docs.slice(s, s + 20);
    var results = await Promise.all(chunk.map(function (d) {
      return db.db.collection(db.COLL.EXPENSES).add({ data: d }).then(function () {
        return true;
      }).catch(function (err) {
        if (db.isDuplicateKey(err)) return false; // 已经导入过
        console.warn('[login][importLocal] 单条账目写入失败：' + db.errString(err).slice(0, 160));
        return false;
      });
    }));
    for (var r = 0; r < results.length; r++) {
      if (results[r]) imported++;
      else skipped++;
    }
  }

  await db.touchRoom(created.roomId);

  return {
    code: created.code,
    roomId: created.roomId,
    imported: imported,
    skipped: skipped
  };
}

exports.main = db.createHandler('login', {
  whoami: whoami,
  importLocal: importLocal
});
