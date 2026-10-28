/**
 * cloudfunctions/expense/index.js
 * 账目：记账 / 改账 / 删除（软删）/ 结清 / 反结清 / 列表（游标分页）/ 汇总
 *
 * 业务规则（改动前请一起看）：
 *  - 分摊一律服务端用 _shared/finance.js 的 computeShares 重算，客户端算的结果只当参考；
 *  - payer 与 participants 必须是本房间 status:'active' 的成员（含迁移进来的待认领成员）；
 *  - 幂等：(roomId, clientId) 唯一，重复提交返回已有那条，不会记两笔；
 *  - 删除是软删除 revoked:true，账目仍留在库里做审计；
 *  - 结清按「一笔账里的某个人」逐笔标记，重复调用不重复写 settle_logs。
 */
var fs = require('fs');
var path = require('path');

/* 共享模块：仓库里在 ../_shared；上传云函数时若已复制成函数内 shared/，则走 ./shared（见 README「部署步骤」） */
var SHARED = fs.existsSync(path.join(__dirname, '..', '_shared', 'db.js')) ? '../_shared/' : './shared/';
var db = require(SHARED + 'db.js');
var V = require(SHARED + 'validate.js');
var F = require(SHARED + 'finance.js');

var BATCH_SIZE = 40;        // 列表分批扫描的批大小
var PAGE_MAX_SCAN = 8;      // filter:'open' 时最多翻 8 批（约 320 条），防止一次调用扫全表
var SUMMARY_MAX = 2000;     // 汇总最多拉取 2000 条账目

/* ---------------- 出参整形 ---------------- */
/** settleMeta 里存的是 openid，出参只保留时间与「是否我点的」，不外泄别人的 openid */
function maskSettleMeta(meta, openid) {
  var src = meta || {};
  var out = {};
  Object.keys(src).forEach(function (name) {
    var item = src[name] || {};
    out[name] = { at: item.at || 0, byMe: item.openid === openid };
  });
  return out;
}

function view(doc, openid) {
  return {
    id: doc._id,
    roomId: doc.roomId,
    clientId: doc.clientId,
    date: doc.date,
    item: doc.item,
    category: doc.category,
    amount: doc.amount,
    payer: doc.payer,
    mode: doc.mode || 'equal',
    participants: doc.participants || [],
    shares: doc.shares || [],
    settled: doc.settled || {},
    settleMeta: maskSettleMeta(doc.settleMeta, openid),
    source: doc.source || 'nl',
    receipt: doc.receipt || null,
    raw: doc.raw || '',
    revoked: !!doc.revoked,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdByMe: doc.createdBy === openid
  };
}

/** 这笔账里还有没有没结清的人（垫付人自己不算） */
function isOpen(doc) {
  var shares = (doc.shares && doc.shares.length) ? doc.shares : F.computeShares(doc.amount, doc.participants || []);
  var settled = doc.settled || {};
  for (var i = 0; i < shares.length; i++) {
    if (shares[i].name === doc.payer) continue;
    if (settled[shares[i].name] !== true) return true;
  }
  return false;
}

function initSettled(parts, payer) {
  var settled = {};
  (parts || []).forEach(function (p) {
    /* 垫付人自己那份额不需要“结清”，直接算已了 */
    settled[p.name] = p.name === payer;
  });
  return settled;
}

function shareOf(doc, name) {
  var shares = (doc.shares && doc.shares.length) ? doc.shares : F.computeShares(doc.amount, doc.participants || []);
  for (var i = 0; i < shares.length; i++) {
    if (shares[i].name === name) return shares[i].share;
  }
  return null;
}

/** 取一笔账并校验成员身份：非成员一律 NOT_MEMBER，天然隔离跨房间读取 */
async function loadExpense(expenseId, openid) {
  var doc = await db.getDocOrNull(db.COLL.EXPENSES, expenseId);
  if (!doc) throw new db.AppError(db.ERR.INVALID, '账目不存在');
  var target = await db.assertMember(doc.roomId, openid);
  return { doc: doc, room: target.room, member: target.member };
}

/* ---------------- add ---------------- */
async function add(ctx) {
  var p = ctx.payload || {};
  var target = await db.resolveRoom(ctx.openid, p.roomId);
  var roomId = target.room._id;

  var clientId = V.clientId(p.clientId);
  var names = await db.activeMemberNames(roomId);

  var amount = V.amount(p.amount);
  var date = (p.date === undefined || p.date === null || p.date === '') ? db.bjDateStr() : V.dateStr(p.date);
  var item = V.item(p.item);
  var category = V.category(p.category, item);
  var payer = V.memberName(p.payer, names, '垫付人');
  var mode = V.mode(p.mode);
  var parts = V.participants(p.participants, names);
  var source = p.source === 'receipt' ? 'receipt' : 'nl';
  var receipt = V.receipt(p.receipt);
  var raw = V.rawText(p.raw);

  /* 幂等：先查一次（索引是兜底）。重试/重复点击只会拿到同一条 */
  var dupRes = await db.db.collection(db.COLL.EXPENSES)
    .where({ roomId: roomId, clientId: clientId })
    .limit(1)
    .get();
  var dup = (dupRes.data && dupRes.data[0]) || null;
  if (dup) return { expense: view(dup, ctx.openid), duplicated: true };

  var now = Date.now();
  var doc = {
    roomId: roomId,
    clientId: clientId,
    date: date,
    item: item,
    category: category,
    amount: amount,
    payer: payer,
    mode: mode,
    participants: parts,
    /* 客户端算的分摊不可信：这里按同一份 finance.js 重算，尾差落在最后一人 */
    shares: F.computeShares(amount, parts),
    settled: initSettled(parts, payer),
    settleMeta: {},
    source: source,
    receipt: receipt,
    raw: raw,
    revoked: false,
    createdBy: ctx.openid,
    updatedBy: ctx.openid,
    createdAt: now,
    updatedAt: now
  };

  var res;
  try {
    res = await db.db.collection(db.COLL.EXPENSES).add({ data: doc });
  } catch (e) {
    if (db.isDuplicateKey(e)) {
      var again = await db.db.collection(db.COLL.EXPENSES)
        .where({ roomId: roomId, clientId: clientId })
        .limit(1)
        .get();
      var exist = (again.data && again.data[0]) || null;
      if (exist) return { expense: view(exist, ctx.openid), duplicated: true };
    }
    throw e;
  }

  doc._id = res && (res._id || res.id);
  await db.touchRoom(roomId);
  return { expense: view(doc, ctx.openid), duplicated: false };
}

/* ---------------- update ---------------- */
async function update(ctx) {
  var p = ctx.payload || {};
  var expenseId = V.docId(p.expenseId, '账目 ID');
  var loaded = await loadExpense(expenseId, ctx.openid);
  var doc = loaded.doc;
  if (doc.revoked) throw new db.AppError(db.ERR.INVALID, '这笔账已经删除了，不能再改');

  /* 权限同撤销：房主可改任何一笔，成员只能改自己记的 */
  var editorRole = loaded.member && loaded.member.role;
  if (editorRole !== 'owner' && doc.createdBy !== ctx.openid) {
    throw new db.AppError(db.ERR.NO_AUTH, '只有房主，或记这笔账的人，才能修改');
  }

  var patch = V.patchObject(p.patch);
  var names = await db.activeMemberNames(doc.roomId);
  var changed = 0;

  var next = {
    date: doc.date,
    item: doc.item,
    category: doc.category,
    amount: doc.amount,
    payer: doc.payer,
    mode: doc.mode || 'equal',
    participants: (doc.participants || []).map(function (x) {
      return { name: x.name, weight: (x.weight === undefined || x.weight === null) ? 1 : x.weight };
    })
  };

  /* 只认这 7 个字段；其它字段（shares / settled / createdBy …）一律忽略，防止客户端改坏审计信息 */
  if (patch.date !== undefined) { next.date = V.dateStr(patch.date); changed++; }
  if (patch.item !== undefined) { next.item = V.item(patch.item); changed++; }
  if (patch.category !== undefined) { next.category = V.category(patch.category, next.item); changed++; }
  if (patch.amount !== undefined) { next.amount = V.amount(patch.amount); changed++; }
  if (patch.payer !== undefined) { next.payer = V.memberName(patch.payer, names, '垫付人'); changed++; }
  if (patch.mode !== undefined) { next.mode = V.mode(patch.mode); changed++; }
  if (patch.participants !== undefined) { next.participants = V.participants(patch.participants, names); changed++; }

  if (!changed) throw new db.AppError(db.ERR.INVALID, '没有可更新的内容（只支持 date/item/category/amount/payer/mode/participants）');
  if (!next.participants.length) throw new db.AppError(db.ERR.INVALID, '至少要有一个分摊人');

  /* 金额、垫付人或参与人变了 → 旧的分摊与结清状态都不再成立，整体重置 */
  var splitChanged = next.amount !== doc.amount ||
    next.payer !== doc.payer ||
    JSON.stringify(next.participants) !== JSON.stringify(doc.participants || []);

  var settled;
  var settleMeta;
  if (splitChanged) {
    settled = initSettled(next.participants, next.payer);
    settleMeta = {};
  } else {
    settled = Object.assign({}, doc.settled || {});
    next.participants.forEach(function (x) {
      if (x.name === next.payer) settled[x.name] = true;
    });
    settleMeta = Object.assign({}, doc.settleMeta || {});
  }

  await db.db.collection(db.COLL.EXPENSES).doc(expenseId).update({
    data: {
      date: next.date,
      item: next.item,
      category: next.category,
      amount: next.amount,
      payer: next.payer,
      mode: next.mode,
      participants: next.participants,
      shares: F.computeShares(next.amount, next.participants),
      settled: settled,
      settleMeta: settleMeta,
      updatedBy: ctx.openid,
      updatedAt: Date.now()
    }
  });

  var fresh = await db.getDocOrNull(db.COLL.EXPENSES, expenseId);
  await db.touchRoom(doc.roomId);
  return { expense: view(fresh, ctx.openid) };
}

/* ---------------- revoke ---------------- */
async function revoke(ctx) {
  var p = ctx.payload || {};
  var expenseId = V.docId(p.expenseId, '账目 ID');
  var loaded = await loadExpense(expenseId, ctx.openid);
  var doc = loaded.doc;

  if (doc.revoked) return { id: expenseId, revoked: true, already: true };

  /* 权限：房主可以撤销任何一笔；普通成员只能撤销自己记的 */
  var meRole = loaded.member && loaded.member.role;
  if (meRole !== 'owner' && doc.createdBy !== ctx.openid) {
    throw new db.AppError(db.ERR.NO_AUTH, '只有房主，或记这笔账的人，才能撤销');
  }

  await db.db.collection(db.COLL.EXPENSES).doc(expenseId).update({
    data: { revoked: true, updatedBy: ctx.openid, updatedAt: Date.now() }
  });
  await db.touchRoom(doc.roomId);
  return { id: expenseId, revoked: true, already: false };
}

/* ---------------- settle / unsettle ---------------- */
async function settle(ctx) {
  var p = ctx.payload || {};
  var expenseId = V.docId(p.expenseId, '账目 ID');
  var loaded = await loadExpense(expenseId, ctx.openid);
  var doc = loaded.doc;
  if (doc.revoked) throw new db.AppError(db.ERR.INVALID, '这笔账已经删除了，不能结清');

  var from = V.personName(p.from);
  var to = V.personName(p.to);
  var amountIn = V.amount(p.amount);
  if (from === to) throw new db.AppError(db.ERR.INVALID, '结清的双方不能是同一个人');
  if (doc.payer !== to) throw new db.AppError(db.ERR.INVALID, '只能结清给这笔账的垫付人：' + doc.payer);

  var share = shareOf(doc, from);
  if (share === null) throw new db.AppError(db.ERR.INVALID, '「' + from + '」没有参与这笔分摊');
  if (Math.abs(share - amountIn) > 0.01) {
    throw new db.AppError(db.ERR.INVALID, '金额和该笔分摊对不上：' + from + ' 这笔记应还 ' + F.plain(share) + ' 元');
  }

  /* 幂等：已经是结清状态就直接返回，不再写日志 */
  if (doc.settled && doc.settled[from] === true) {
    return { expenseId: expenseId, from: from, to: to, amount: share, settled: true, duplicate: true };
  }

  var settled = Object.assign({}, doc.settled || {});
  settled[from] = true;
  var meta = Object.assign({}, doc.settleMeta || {});
  meta[from] = { openid: ctx.openid, at: Date.now() };
  var now = Date.now();

  /* 账目状态 + 流水一起写，要么都成要么都不成 */
  await db.runTx(async function (t) {
    await t.collection(db.COLL.EXPENSES).doc(expenseId).update({
      data: { settled: settled, settleMeta: meta, updatedBy: ctx.openid, updatedAt: now }
    });
    await t.collection(db.COLL.SETTLE_LOGS).add({
      data: {
        roomId: doc.roomId,
        expenseId: expenseId,
        from: from,
        to: to,
        amount: share,
        action: 'settle',
        byOpenid: ctx.openid,
        byName: loaded.member.name,
        at: now
      }
    });
  });

  return { expenseId: expenseId, from: from, to: to, amount: share, settled: true, duplicate: false };
}

async function unsettle(ctx) {
  var p = ctx.payload || {};
  var expenseId = V.docId(p.expenseId, '账目 ID');
  var loaded = await loadExpense(expenseId, ctx.openid);
  var doc = loaded.doc;
  if (doc.revoked) throw new db.AppError(db.ERR.INVALID, '这笔账已经删除了，不能反结清');

  var from = V.personName(p.from);
  var to = V.personName(p.to);
  if (from === to) throw new db.AppError(db.ERR.INVALID, '结清的双方不能是同一个人');
  if (doc.payer !== to) throw new db.AppError(db.ERR.INVALID, '只能给这笔账的垫付人反结清：' + doc.payer);

  var share = shareOf(doc, from);
  if (share === null) throw new db.AppError(db.ERR.INVALID, '「' + from + '」没有参与这笔分摊');

  /* 幂等：本来就没结清，直接返回 */
  if (!doc.settled || doc.settled[from] !== true) {
    return { expenseId: expenseId, from: from, to: to, amount: share, settled: false, duplicate: true };
  }

  var settled = Object.assign({}, doc.settled || {});
  delete settled[from];
  var meta = Object.assign({}, doc.settleMeta || {});
  delete meta[from];
  var now = Date.now();

  await db.runTx(async function (t) {
    await t.collection(db.COLL.EXPENSES).doc(expenseId).update({
      data: { settled: settled, settleMeta: meta, updatedBy: ctx.openid, updatedAt: now }
    });
    await t.collection(db.COLL.SETTLE_LOGS).add({
      data: {
        roomId: doc.roomId,
        expenseId: expenseId,
        from: from,
        to: to,
        amount: share,
        action: 'undo',
        byOpenid: ctx.openid,
        byName: loaded.member.name,
        at: now
      }
    });
  });

  return { expenseId: expenseId, from: from, to: to, amount: share, settled: false, duplicate: false };
}

/* ---------------- list ---------------- */
/**
 * 游标分页：按 date desc, createdAt desc, _id desc。
 * 游标条件写成 _.or([...]) 的三个分支（早于游标日 / 同日更早 / 同日同时更小 id），
 * 不用 offset，翻到后面也不会因为新增账目而漏页。
 */
function baseWhere(roomId) {
  return { roomId: roomId, revoked: false };
}

async function readPage(roomId, month, cursor, size) {
  var base = baseWhere(roomId);
  var start = month ? (month + '-01') : '';
  var end = month ? (month + '-31') : '';
  var query;

  if (cursor && cursor.d) {
    var olderDate = month
      ? db._.gte(start).and(db._.lt(cursor.d))
      : db._.lt(cursor.d);
    var branches = [
      Object.assign({}, base, { date: olderDate }),
      Object.assign({}, base, { date: cursor.d, createdAt: db._.lt(cursor.t) }),
      Object.assign({}, base, { date: cursor.d, createdAt: cursor.t, _id: db._.lt(cursor.i) })
    ];
    query = db.db.collection(db.COLL.EXPENSES).where(db._.or(branches));
  } else {
    var cond = base;
    if (month) cond.date = db._.gte(start).and(db._.lte(end));
    query = db.db.collection(db.COLL.EXPENSES).where(cond);
  }

  var res = await query
    .orderBy('date', 'desc')
    .orderBy('createdAt', 'desc')
    .orderBy('_id', 'desc')
    .limit(size)
    .get();
  return (res && res.data) || [];
}

async function list(ctx) {
  var p = ctx.payload || {};
  var target = await db.resolveRoom(ctx.openid, p.roomId);
  var roomId = target.room._id;

  var pageSize = V.limit(p.limit, 30, 100);
  var onlyOpen = V.filter(p.filter) === 'open';
  var month = p.month ? V.monthStr(p.month) : '';
  var cursor = V.decodeCursor(p.cursor);

  var picked = [];
  var last = cursor;
  var exhausted = false;
  var guard = 0;

  while (picked.length < pageSize + 1 && !exhausted && guard < PAGE_MAX_SCAN) {
    guard++;
    var batch = await readPage(roomId, month, last, BATCH_SIZE);
    if (!batch.length) {
      exhausted = true;
      break;
    }
    for (var i = 0; i < batch.length; i++) {
      var doc = batch[i];
      last = { d: doc.date, t: Number(doc.createdAt) || 0, i: doc._id };
      if (onlyOpen && !isOpen(doc)) continue;
      picked.push({ doc: doc, cur: last });
      if (picked.length >= pageSize + 1) break;
    }
    if (batch.length < BATCH_SIZE) exhausted = true;
  }

  var hasMore = picked.length > pageSize;
  if (!exhausted && picked.length <= pageSize) hasMore = true;

  var items = picked.slice(0, pageSize);
  var nextCursor = (hasMore && items.length) ? V.encodeCursor(items[items.length - 1].cur) : '';

  return {
    items: items.map(function (x) { return view(x.doc, ctx.openid); }),
    nextCursor: nextCursor,
    hasMore: hasMore
  };
}

/* ---------------- summary ---------------- */
/** 拉本房间全部未删除账目（备份/月报口径），按 date desc, createdAt desc 排好 */
async function fetchAllExpenses(roomId, cap) {
  var out = [];
  var lastId = null;
  while (out.length < cap) {
    var query;
    if (lastId) {
      query = db.db.collection(db.COLL.EXPENSES)
        .where({ roomId: roomId, revoked: false, _id: db._.gt(lastId) });
    } else {
      query = db.db.collection(db.COLL.EXPENSES).where({ roomId: roomId, revoked: false });
    }
    var res = await query.orderBy('_id', 'asc').limit(100).get();
    var list = (res && res.data) || [];
    if (!list.length) break;
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    lastId = list[list.length - 1]._id;
    if (list.length < 100) break;
  }

  var mapped = out.map(function (d) {
    var copy = Object.assign({}, d);
    copy.id = d._id; // finance.js 里的 unsettled/unsettledItems 用 id 标记「哪一笔」
    if (!copy.shares || !copy.shares.length) copy.shares = F.computeShares(copy.amount, copy.participants || []);
    return copy;
  });
  mapped.sort(function (a, b) {
    if (a.date === b.date) return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
    return a.date < b.date ? 1 : -1;
  });
  return mapped;
}

async function summary(ctx) {
  var target = await db.resolveRoom(ctx.openid, (ctx.payload || {}).roomId);
  var roomId = target.room._id;

  var all = await fetchAllExpenses(roomId, SUMMARY_MAX);
  var memberDocs = await db.listActiveMembers(roomId);
  var names = memberDocs.map(function (m) { return m.name; });
  var month = db.bjMonthStr();

  /* 月度口径：当月记账总额与人均；余额/待结清用全部账目（跨月结转才不会丢账） */
  var monthList = all.filter(function (e) { return String(e.date || '').slice(0, 7) === month; });
  var total = F.num(monthList.reduce(function (s, e) { return s + F.num(e.amount); }, 0));
  var perHead = names.length ? F.num(total / names.length) : 0;

  var openPairs = F.unsettled(all).map(function (x) {
    return {
      from: x.from,
      to: x.to,
      amount: x.amount,
      items: (x.items || []).map(function (it) { return { item: it.item, amount: it.amount }; })
    };
  });
  var openTotal = F.num(openPairs.reduce(function (s, x) { return s + x.amount; }, 0));

  var statusByName = {};
  memberDocs.forEach(function (m) { statusByName[m.name] = 'active'; });

  return {
    month: month,
    total: total,
    count: monthList.length,
    perHead: perHead,
    openPairs: openPairs,
    openTotal: openTotal,
    recent: all.slice(0, 5).map(function (d) { return view(d, ctx.openid); }),
    members: F.balances(all, names).map(function (b) {
      return {
        name: b.name,
        status: statusByName[b.name] || (b.ex ? 'ex' : 'quit'),
        net: b.net,
        paid: b.paid,
        owed: b.owed
      };
    })
  };
}

/**
 * 把两个人的账一次性结清（首页「标记已结清」用这个）
 *
 * 语义与小程序端 finance.settlePair 保持一致：A 垫的账里 B 那份、B 垫的账里 A 那份，全部标记结清。
 * 单笔结清请用 settle（它要求金额与该笔分摊严格对上），这里是"这一对账我们清了"的粗粒度操作。
 */
async function settlePair(ctx) {
  var p = ctx.payload || {};
  var target = await db.resolveRoom(ctx.openid, p.roomId);
  var roomId = target.room._id;
  var a = V.personName(p.from);
  var b = V.personName(p.to);
  if (a === b) throw new db.AppError(db.ERR.INVALID, '结清的双方不能是同一个人');

  var all = await fetchAllExpenses(roomId, SUMMARY_MAX);
  var now = Date.now();
  var done = [];

  for (var i = 0; i < all.length; i++) {
    var doc = all[i];
    if (doc.revoked) continue;
    if (doc.payer !== a && doc.payer !== b) continue;

    var debtor = doc.payer === a ? b : a;
    var shares = (doc.shares && doc.shares.length) ? doc.shares : F.computeShares(doc.amount, doc.participants || []);
    var share = null;
    for (var j = 0; j < shares.length; j++) {
      if (shares[j].name === debtor) { share = shares[j].share; break; }
    }
    if (share === null) continue;
    if (doc.settled && doc.settled[debtor] === true) continue;

    var settled = Object.assign({}, doc.settled || {});
    settled[debtor] = true;
    var meta = Object.assign({}, doc.settleMeta || {});
    meta[debtor] = { openid: ctx.openid, at: now };

    /* 账目 + 流水一起写；闭包用立即执行包一层，避免 var 在循环里被后续迭代覆盖 */
    await (function (docId, debt, payer, amt, settledSnap, metaSnap) {
      return db.runTx(async function (t) {
        await t.collection(db.COLL.EXPENSES).doc(docId).update({
          data: { settled: settledSnap, settleMeta: metaSnap, updatedBy: ctx.openid, updatedAt: now }
        });
        await t.collection(db.COLL.SETTLE_LOGS).add({
          data: {
            roomId: roomId,
            expenseId: docId,
            from: debt,
            to: payer,
            amount: amt,
            action: 'settle',
            byOpenid: ctx.openid,
            byName: target.member.name,
            at: now
          }
        });
      });
    })(doc._id, debtor, doc.payer, share, settled, meta);

    done.push({ expenseId: doc._id, from: debtor, to: doc.payer, amount: share });
  }

  return { count: done.length, items: done };
}


/**
 * 结清流水：谁在什么时候把哪一笔的哪一份标记了结清/撤销。
 * 不传 expenseId 就是整个房间最近 50 条。
 */
async function logs(ctx) {
  var p = ctx.payload || {};
  var target = await db.resolveRoom(ctx.openid, p.roomId);
  var roomId = target.room._id;
  var where = { roomId: roomId };
  if (p.expenseId) where.expenseId = V.docId(p.expenseId, '账目 ID');
  var res = await db.db.collection(db.COLL.SETTLE_LOGS)
    .where(where)
    .orderBy('at', 'desc')
    .limit(50)
    .get();
  return {
    items: (res.data || []).map(function (x) {
      return {
        expenseId: x.expenseId,
        from: x.from,
        to: x.to,
        amount: x.amount,
        action: x.action,
        byName: x.byName || '',
        at: x.at
      };
    })
  };
}

exports.main = db.createHandler('expense', {
  add: add,
  update: update,
  revoke: revoke,
  settle: settle,
  settlePair: settlePair,
  unsettle: unsettle,
  list: list,
  logs: logs,
  summary: summary
});
