/**
 * 数据门面（本机模式 ⇄ 云端模式）
 *
 * 设计目标：**页面代码基本不用改**。
 *   - 读：`getState()` 仍是同步返回一个 {members, me, expenses, room, rooms, ai}；
 *   - 写：页面照旧 `store.mutate(fn)` 改这份状态，云端模式下由本文件"比对前后差异"再推给云函数；
 *   - 页面只需要在 onShow 里把 `refresh()` 换成 `store.load().then(() => this.refresh())`。
 *
 * 为什么用"改完再比对"而不是让页面逐个调接口：
 *   现在的页面是围绕"本地数组"写的（结算=改 settled、撤销=删一条、改名=批量改历史），
 *   一次性改成逐个 action 风险大；用差异同步可以把迁移风险收敛在这一个文件里，
 *   并且本机模式完全不受影响（走的是原来的 rooms.js）。
 *
 * 开关：config/env.js 的 `cloudLedger`。没打开时永远是本机模式。
 */
const F = require('./finance.js');
const rooms = require('./rooms.js');
const api = require('./api.js');
const user = require('./user.js');
const env = require('../config/env.js');

const MAX_FETCH = 500; // 一个寝室一学期够用了；超过就走分页（后续再做）

/** 云端缓存：页面读的就是它 */
let cloud = {
  ready: false,
  data: { members: [], me: '', expenses: [], room: null, rooms: [], ai: {}, memberDetail: [] }
};

function cloudOn() {
  return !!env.cloudLedger && api.isReady() && !!user.currentRoom();
}

function isCloud() {
  return cloudOn();
}

/* ---------------- 本机模式（原逻辑，一行没动） ---------------- */
function localState() {
  const S = rooms.session;
  if (!S.room || !rooms.readRoom(S.room.code)) rooms.bootRooms();
  const s = rooms.session;
  return {
    members: s.members,
    me: s.me,
    expenses: s.expenses,
    room: s.room,
    rooms: s.rooms,
    ai: rooms.readAiCfg()
  };
}

/* ---------------- 读 ---------------- */
function getState() {
  if (!cloudOn()) return localState();
  return cloud.data;
}

function roomMeta() {
  const r = user.currentRoom();
  if (!r) return null;
  return { code: r.code, label: r.name, role: r.role, id: r.id };
}

/** 云端：拉全量账目 + 成员，写进缓存（≤500 笔） */
function load() {
  if (!cloudOn()) return Promise.resolve(getState());
  const r = roomMeta();
  return Promise.all([fetchAllExpenses(), api.room.members()]).then(function (res) {
    const expenses = res[0] || [];
    const mres = res[1] || {};
    const detail = (mres.members || []).map(function (m) {
      return { name: m.name, role: m.role, status: m.status, pending: !!m.pending, isMe: !!m.isMe };
    });
    const active = detail.filter(function (m) { return m.status === 'active'; });
    const me = (user.get() && user.get().profile && user.get().profile.name) || (active[0] ? active[0].name : '');
    cloud.data = {
      members: active.map(function (m) { return m.name; }),
      me: me,
      expenses: F.ensureShares(expenses),
      room: { code: r.code, label: r.name, role: r.role || '' },
      rooms: [{ code: r.code, label: r.name, createdAt: 0, updatedAt: 0 }],
      ai: rooms.readAiCfg(),
      memberDetail: detail
    };
    cloud.ready = true;
    return cloud.data;
  });
}

function fetchAllExpenses() {
  const out = [];
  let cursor = null;
  let guard = 0;
  function step() {
    guard++;
    return api.expense.list({ cursor: cursor, limit: 100 }).then(function (res) {
      (res.items || []).forEach(function (x) { out.push(x); });
      if (res.hasMore && res.nextCursor && out.length < MAX_FETCH && guard < 10) {
        cursor = res.nextCursor;
        return step();
      }
      return out;
    });
  }
  return step();
}

/**
 * 页面 onShow 统一用这个：先把云端数据拉到缓存，再渲染。
 * 本机模式下同步回调，页面代码不用区分两种模式。
 */
function loadThen(cb) {
  const done = function () {
    try {
      if (typeof cb === 'function') cb();
    } catch (e) {
      console.error('render after load failed', e);
    }
  };
  if (!cloudOn()) {
    done();
    return Promise.resolve();
  }
  return load().then(done).catch(function () { done(); });
}

/* ---------------- 写：本机走原路径，云端走差异同步 ---------------- */
function buildExpense(fields) {
  return localBuild(fields);
}

function localBuild(fields) {
  const participants = (fields.participants || []).map(function (p) {
    return typeof p === 'string' ? { name: p } : { name: p.name, weight: p.weight };
  });
  const amount = F.num(fields.amount);
  const shares = F.computeShares(amount, participants);
  const settled = {};
  participants.forEach(function (p) { settled[p.name] = p.name === fields.payer; });
  return {
    id: fields.id || 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: fields.date || F.todayStr(),
    item: fields.item || '公共开支',
    category: fields.category || F.guessCategory(fields.item),
    amount: amount,
    payer: fields.payer,
    mode: fields.mode || 'equal',
    participants: participants,
    settled: settled,
    shares: shares,
    source: fields.source || 'nl',
    receipt: fields.receipt || null,
    raw: fields.raw || ''
  };
}

/** 页面统一用这个：fn(state) 里想怎么改就怎么改，云端模式会自动推差异 */
function mutate(fn) {
  if (!cloudOn()) {
    const S = rooms.session;
    if (!S.room) rooms.bootRooms();
    fn(S);
    rooms.save();
    return Promise.resolve(S);
  }
  const before = snapshot(cloud.data.expenses);
  const membersBefore = (cloud.data.members || []).slice();
  fn(cloud.data);
  cloud.data.expenses = F.ensureShares(cloud.data.expenses);
  const ops = diff(before, cloud.data.expenses, membersBefore, cloud.data.members || []);
  return runOps(ops).catch(function (err) {
    // 推送失败：把乐观改动丢掉，回到云端真实状态，并提示用户
    wx.showToast({ title: (err && err.message) || '保存失败，已回到云端数据', icon: 'none' });
    return load();
  });
}

function snapshot(expenses) {
  const map = {};
  (expenses || []).forEach(function (e) { map[e.id] = e; });
  return map;
}

function sharesOf(e) {
  return (e.shares && e.shares.length) ? e.shares : F.computeShares(e.amount, e.participants || []);
}

function diff(before, after, membersBefore, membersAfter) {
  const ops = [];
  const afterMap = {};

  (after || []).forEach(function (e) {
    afterMap[e.id] = e;
    const old = before[e.id];
    if (!old) {
      // 新增：客户端先生成 id 作为幂等键（云端字段是 clientId）
      ops.push({ type: 'add', rec: e });
      return;
    }
    const shares = sharesOf(e);
    const oldSettled = old.settled || {};
    const nowSettled = e.settled || {};
    shares.forEach(function (s) {
      if (s.name === e.payer) return;
      const was = oldSettled[s.name] === true;
      const now = nowSettled[s.name] === true;
      if (!was && now) ops.push({ type: 'settle', expenseId: e.id, from: s.name, to: e.payer, amount: s.share });
      if (was && !now) ops.push({ type: 'unsettle', expenseId: e.id, from: s.name, to: e.payer });
    });
  });

  // 被删掉 = 撤销
  Object.keys(before).forEach(function (id) {
    if (!afterMap[id]) ops.push({ type: 'revoke', expenseId: id });
  });

  // 成员增减（改名走的是别的入口，这里只处理加了/删了）
  membersAfter.forEach(function (name) {
    if (membersBefore.indexOf(name) < 0) ops.push({ type: 'addMember', name: name });
  });
  membersBefore.forEach(function (name) {
    if (membersAfter.indexOf(name) < 0) ops.push({ type: 'removeMember', name: name });
  });

  return ops;
}

function runOps(ops) {
  if (!ops.length) return Promise.resolve([]);
  const results = [];
  function step(i) {
    if (i >= ops.length) return Promise.resolve(results);
    const op = ops[i];
    return applyOp(op).then(function (r) {
      results.push(r);
      return step(i + 1);
    });
  }
  return step(0);
}

function applyOp(op) {
  if (op.type === 'add') {
    const rec = op.rec;
    return api.expense.add({
      clientId: rec.id,
      date: rec.date,
      item: rec.item,
      category: rec.category,
      amount: rec.amount,
      payer: rec.payer,
      mode: rec.mode,
      participants: rec.participants,
      source: rec.source,
      receipt: rec.receipt,
      raw: rec.raw
    }).then(function (res) {
      const doc = (res && res.expense) || null;
      if (doc) {
        // 用云端返回的记录替换本地临时记录（云端的 id 才是权威 id）
        const idx = cloud.data.expenses.findIndex(function (x) { return x.id === rec.id; });
        if (idx >= 0) cloud.data.expenses[idx] = Object.assign({}, doc, { shares: F.ensureShares([doc])[0].shares });
      }
      return doc;
    });
  }
  if (op.type === 'settle') return api.expense.settle(op.expenseId, op.from, op.to, op.amount);
  if (op.type === 'unsettle') return api.expense.unsettle(op.expenseId, op.from, op.to);
  if (op.type === 'revoke') return api.expense.revoke(op.expenseId);
  if (op.type === 'addMember') return api.room.addMember(op.name);
  if (op.type === 'removeMember') return api.room.removeMember(op.name);
  return Promise.resolve(null);
}

/* ---------------- 给页面用的辅助动作（两种模式同一套签名） ---------------- */
function addExpense(fields) {
  if (!cloudOn()) {
    const rec = localBuild(fields);
    const S = rooms.session;
    S.expenses.unshift(rec);
    rooms.save();
    return Promise.resolve(rec);
  }
  return mutate(function (state) { state.expenses.unshift(localBuild(fields)); }).then(function () {
    return cloud.data.expenses[0];
  });
}

/** 改自己的昵称（云端走 updateProfile，本机走 renameMember） */
function renameMe(newName) {
  if (!cloudOn()) {
    const S = rooms.session;
    const r = F.renameMember({ members: S.members, me: S.me, expenses: S.expenses }, S.me, newName);
    S.members = r.members;
    S.me = r.me;
    S.expenses = r.expenses;
    rooms.save();
    return Promise.resolve(S);
  }
  return api.room.updateProfile(newName).then(function () { return load(); });
}

function members() {
  if (!cloudOn()) return Promise.resolve(localState().members.map(function (n) { return { name: n, status: 'active', isMe: n === localState().me }; }));
  return Promise.resolve(cloud.data.memberDetail || []);
}

function reseed() {
  const S = rooms.session;
  S.expenses = F.seed(S.members);
  rooms.save();
  return Promise.resolve(S);
}

function clearExpenses() {
  if (!cloudOn()) {
    const S = rooms.session;
    S.expenses = [];
    rooms.save();
    return Promise.resolve(S);
  }
  // 云端"清空"= 逐笔撤销（保留审计），这里交给页面确认后再逐条调用
  const ids = (cloud.data.expenses || []).map(function (e) { return e.id; });
  return ids.reduce(function (p, id) {
    return p.then(function () { return api.expense.revoke(id); });
  }, Promise.resolve()).then(function () { return load(); });
}

function saveAi(cfg) {
  rooms.writeAiCfg(cfg);
}

function switchRoom(code) {
  rooms.switchRoom(code);
  return rooms.session;
}

function newRoom() {
  return rooms.newRoom();
}

module.exports = {
  isCloud: isCloud,
  load: load,
  loadThen: loadThen,
  getState: getState,
  mutate: mutate,
  buildExpense: buildExpense,
  addExpense: addExpense,
  renameMe: renameMe,
  members: members,
  reseed: reseed,
  clearExpenses: clearExpenses,
  saveAi: saveAi,
  switchRoom: switchRoom,
  newRoom: newRoom,
  rooms: rooms
};
