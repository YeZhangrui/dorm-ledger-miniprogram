/**
 * 房间码（本机分区存储）—— 与 demo 的房间码实现同语义，换成 wx 存储 API
 *   qinzhang_rooms_v1          房间目录 + 当前房间 {v,current,rooms:[{code,label,createdAt,updatedAt}]}
 *   qinzhang_room_<CODE>       单房间账本 {v:4,code,label,members,me,expenses,createdAt,updatedAt}
 *   qinzhang_migrated_v1       旧数据迁移标记（只搬一次）
 *   dorm-ledger-ai-v1          AI 识图配置（全局，不按房间分）
 */
const F = require('./finance.js');

const ROOM_KEY_PREFIX = 'qinzhang_room_';
const ROOMS_KEY = 'qinzhang_rooms_v1';
const ROOM_MIGRATE_KEY = 'qinzhang_migrated_v1';
const AI_CFG_KEY = 'dorm-ledger-ai-v1';
const LEGACY_KEYS = ['dorm-ledger-demo-v3', 'dorm-ledger-demo-v2', 'dorm-ledger-demo-v1'];

const ROOM_SCHEMA = 4;
const ROOM_CODE_LEN = 6;
/* 32 个字符：去掉易混淆的 0 O 1 I l */
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ---------------- 低层存储 ---------------- */
function safeGet(key) {
  try {
    const v = wx.getStorageSync(key);
    return v === '' ? null : v;
  } catch (e) {
    return null;
  }
}
function safeSet(key, value) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (e) {
    return false;
  }
}
function storageKeys() {
  try {
    const info = wx.getStorageInfoSync();
    return (info && info.keys) || [];
  } catch (e) {
    return [];
  }
}
function roomKey(code) {
  return ROOM_KEY_PREFIX + code;
}

/* ---------------- 房间码 ---------------- */
function normalizeRoomCode(input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== ROOM_CODE_LEN) return '';
  for (let i = 0; i < s.length; i++) {
    if (ROOM_ALPHABET.indexOf(s[i]) < 0) return '';
  }
  return s;
}

function genRoomCode(used) {
  const taken = {};
  (used || []).forEach(function (c) { taken[c] = true; });
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!taken[code]) return code;
  }
  return '';
}

/* ---------------- 单房间读写 ---------------- */
function readRoom(code) {
  const raw = safeGet(roomKey(code));
  if (!raw || typeof raw !== 'object') return null;
  const members = Array.isArray(raw.members) && raw.members.length >= F.MIN_MEMBERS
    ? raw.members.slice(0, F.MAX_MEMBERS)
    : F.DEFAULT_MEMBERS.slice();
  const me = members.indexOf(raw.me) >= 0 ? raw.me : members[0];
  return {
    code: code,
    label: String(raw.label || ''),
    members: members,
    me: me,
    expenses: F.ensureShares(Array.isArray(raw.expenses) ? raw.expenses : []),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

function writeRoom(code, label, data, createdAt) {
  const payload = {
    v: ROOM_SCHEMA,
    code: code,
    label: String(label || ''),
    members: (data.members || []).slice(),
    me: data.me || (data.members || [])[0],
    expenses: data.expenses || [],
    createdAt: createdAt || Date.now(),
    updatedAt: Date.now()
  };
  safeSet(roomKey(code), payload);
  return payload;
}

/* ---------------- 房间目录 ---------------- */
function readRoomMeta() {
  const raw = safeGet(ROOMS_KEY);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rooms)) {
    return { v: 1, current: '', rooms: [] };
  }
  return {
    v: 1,
    current: normalizeRoomCode(raw.current) || '',
    rooms: raw.rooms.filter(function (r) { return r && normalizeRoomCode(r.code); }).map(function (r) {
      return {
        code: r.code,
        label: String(r.label || ''),
        createdAt: Number(r.createdAt) || 0,
        updatedAt: Number(r.updatedAt) || 0
      };
    })
  };
}

function writeRoomMeta(meta) {
  safeSet(ROOMS_KEY, meta);
}

function scanRoomCodes() {
  const keys = storageKeys();
  const out = [];
  keys.forEach(function (k) {
    if (String(k).indexOf(ROOM_KEY_PREFIX) === 0) {
      const code = normalizeRoomCode(String(k).slice(ROOM_KEY_PREFIX.length));
      if (code && out.indexOf(code) < 0) out.push(code);
    }
  });
  return out;
}

function findRoom(code, meta) {
  const m = meta || readRoomMeta();
  for (let i = 0; i < m.rooms.length; i++) {
    if (m.rooms[i].code === code) return m.rooms[i];
  }
  return null;
}

function ensureRoomMeta(code, label) {
  const meta = readRoomMeta();
  let item = findRoom(code, meta);
  const room = readRoom(code);
  if (!item) {
    item = { code: code, label: label || (room && room.label) || '房间 ' + code, createdAt: Date.now(), updatedAt: Date.now() };
    meta.rooms.push(item);
  } else {
    if (label) item.label = label;
    item.updatedAt = Date.now();
  }
  meta.current = code;
  writeRoomMeta(meta);
  return meta;
}

function createRoom(code, label, data) {
  writeRoom(code, label, data, Date.now());
  ensureRoomMeta(code, label);
  return code;
}

/* ---------------- 旧数据迁移 ---------------- */
function readLegacy() {
  for (let i = 0; i < LEGACY_KEYS.length; i++) {
    const raw = safeGet(LEGACY_KEYS[i]);
    if (!raw) continue;
    if (Array.isArray(raw)) {
      return { members: F.DEFAULT_MEMBERS.slice(), me: F.DEFAULT_MEMBERS[0], expenses: F.ensureShares(raw) };
    }
    if (raw && Array.isArray(raw.expenses)) {
      const members = Array.isArray(raw.members) && raw.members.length >= F.MIN_MEMBERS ? raw.members : F.DEFAULT_MEMBERS.slice();
      return {
        members: members,
        me: members.indexOf(raw.me) >= 0 ? raw.me : members[0],
        expenses: F.ensureShares(raw.expenses)
      };
    }
  }
  return null;
}

/* ---------------- 会话（当前房间） ---------------- */
const S = {
  room: null,      // { code, label, createdAt }
  rooms: [],       // 目录
  members: [],
  me: '',
  expenses: []
};

function applyRoom(roomData) {
  S.members = roomData.members.slice();
  S.me = roomData.me;
  S.expenses = F.ensureShares(roomData.expenses);
  S.room = { code: roomData.code, label: roomData.label || '', createdAt: roomData.createdAt };
}

/** 首次/进入页面时确保有当前房间（含旧数据迁移、目录自愈） */
function bootRooms() {
  let meta = readRoomMeta();
  let codes = meta.rooms.map(function (r) { return r.code; });

  /* 目录丢失但本机还有房间 key：扫描重建 */
  if (!codes.length) {
    const scanned = scanRoomCodes();
    if (scanned.length) {
      meta = { v: 1, current: '', rooms: scanned.map(function (c) {
        const r = readRoom(c);
        return { code: c, label: (r && r.label) || '房间 ' + c, createdAt: (r && r.createdAt) || 0, updatedAt: (r && r.updatedAt) || 0 };
      }) };
      writeRoomMeta(meta);
      codes = meta.rooms.map(function (r) { return r.code; });
    }
  }

  /* 一个房间都没有：先看旧数据要不要迁移 */
  if (!codes.length) {
    const legacy = readLegacy();
    const migrated = safeGet(ROOM_MIGRATE_KEY) === '1';
    const code = genRoomCode([]);
    let data;
    if (legacy && !migrated) {
      data = { members: legacy.members, me: legacy.me, expenses: legacy.expenses };
      safeSet(ROOM_MIGRATE_KEY, '1');
    } else if (legacy && migrated) {
      data = { members: legacy.members, me: legacy.me, expenses: legacy.expenses };
    } else {
      const members = F.DEFAULT_MEMBERS.slice();
      data = { members: members, me: members[0], expenses: F.seed(members) };
    }
    createRoom(code, legacy ? '默认房间（旧数据迁移）' : '默认房间', data);
    meta = readRoomMeta();
    codes = [code];
  }

  /* 选一个当前房间：目录里的 current，否则最近更新的 */
  let code = normalizeRoomCode(meta.current) || '';
  if (!code || codes.indexOf(code) < 0) {
    const rooms = meta.rooms.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    code = (rooms[0] && rooms[0].code) || codes[0];
    meta.current = code;
    writeRoomMeta(meta);
  }

  let room = readRoom(code);
  if (!room) {
    createRoom(code, '默认房间', { members: F.DEFAULT_MEMBERS.slice(), me: F.DEFAULT_MEMBERS[0], expenses: F.seed(F.DEFAULT_MEMBERS) });
    room = readRoom(code);
  }
  applyRoom(room);
  S.rooms = readRoomMeta().rooms;
  return S;
}

/** 保存当前房间（账目/成员/记账人） */
function save() {
  if (!S.room) return S;
  writeRoom(S.room.code, S.room.label, { members: S.members, me: S.me, expenses: S.expenses }, S.room.createdAt);
  ensureRoomMeta(S.room.code, S.room.label);
  S.rooms = readRoomMeta().rooms;
  return S;
}

/** 切房间：先存当前，再整组替换（不做合并） */
function switchRoom(code) {
  if (!code) return S;
  save();
  let room = readRoom(code);
  if (!room) {
    room = {
      code: code, label: '房间 ' + code, members: S.members.slice(), me: S.me,
      expenses: [], createdAt: Date.now(), updatedAt: Date.now()
    };
    writeRoom(code, room.label, room, room.createdAt);
  }
  ensureRoomMeta(code, room.label);
  applyRoom(room);
  S.rooms = readRoomMeta().rooms;
  return S;
}

function newRoom() {
  const used = S.rooms.map(function (r) { return r.code; });
  const code = genRoomCode(used);
  if (!code) return '';
  save();
  createRoom(code, '房间 ' + (S.rooms.length + 1), { members: S.members.slice(), me: S.me, expenses: [] });
  switchRoom(code);
  return code;
}

/* ---------------- 导出 / 导入 ---------------- */
function buildExportPayload() {
  return {
    app: '寝账 · 寝室公共开支台账（小程序版）',
    schema: ROOM_SCHEMA,
    room: S.room ? S.room.code : '',
    roomLabel: S.room ? S.room.label : '',
    exportedAt: new Date().toISOString(),
    members: S.members.slice(),
    me: S.me,
    expenses: S.expenses
  };
}

function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

/** 只认对象结构；坏记录计数后跳过 */
function normalizeImport(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.expenses)) return null;
  const members = [];
  if (Array.isArray(obj.members)) {
    obj.members.forEach(function (n) {
      const s = String(n == null ? '' : n).trim();
      if (s && members.indexOf(s) < 0 && members.length < F.MAX_MEMBERS) members.push(s);
    });
  }
  const finalMembers = members.length >= F.MIN_MEMBERS ? members : S.members.slice();
  const me = (typeof obj.me === 'string' && finalMembers.indexOf(obj.me) >= 0) ? obj.me : finalMembers[0];
  const out = [];
  let skipped = 0;
  obj.expenses.forEach(function (e) {
    if (!e || typeof e !== 'object') { skipped++; return; }
    const amount = Number(e.amount);
    const parts = Array.isArray(e.participants) ? e.participants.filter(function (p) {
      return p && String(p.name == null ? '' : p.name).trim();
    }).map(function (p) {
      const w = Number(p.weight);
      return { name: String(p.name).trim(), weight: w > 0 ? w : 1 };
    }) : [];
    if (!(amount > 0) || !parts.length) { skipped++; return; }
    const settled = {};
    if (e.settled && typeof e.settled === 'object') {
      Object.keys(e.settled).forEach(function (n) { settled[n] = !!e.settled[n]; });
    }
    out.push({
      id: String(e.id || 'i' + Math.random().toString(36).slice(2, 8)),
      date: validDate(e.date) ? e.date : F.todayStr(),
      item: String(e.item || '导入的账目').slice(0, 40),
      category: F.CATEGORIES.indexOf(e.category) >= 0 ? e.category : '其他',
      amount: F.num(amount),
      payer: String(e.payer == null ? '' : e.payer).trim() || me,
      mode: e.mode === 'days' ? 'days' : 'equal',
      participants: parts,
      settled: settled,
      shares: F.computeShares(F.num(amount), parts),
      source: e.source === 'receipt' ? 'receipt' : 'nl',
      raw: String(e.raw || '（导入的账目）').slice(0, 120),
      receipt: e.receipt || null
    });
  });
  return {
    members: finalMembers,
    me: me,
    expenses: out,
    skipped: skipped,
    room: obj.room || '',
    roomLabel: obj.roomLabel || ''
  };
}

/** 落点：newRoom=导入新房间（默认，绝不覆盖）；overwrite=覆盖当前房间 */
function applyImport(draft, mode) {
  if (!draft) return null;
  if (mode === 'overwrite') {
    S.members = draft.members.slice();
    S.me = draft.me;
    S.expenses = draft.expenses.slice();
    save();
    return { mode: 'overwrite', code: S.room.code, count: S.expenses.length };
  }
  save();
  const code = genRoomCode(S.rooms.map(function (r) { return r.code; })) || '';
  if (!code) return null;
  createRoom(code, draft.roomLabel || ('导入 ' + (draft.room || '账本')), {
    members: draft.members, me: draft.me, expenses: draft.expenses
  });
  switchRoom(code);
  return { mode: 'new', code: code, count: S.expenses.length };
}

/* ---------------- 房间码摘录（给页面展示） ---------------- */
function roomSummary() {
  return S.rooms.map(function (r) {
    const room = readRoom(r.code);
    const count = room ? room.expenses.length : 0;
    const total = room ? F.num(room.expenses.reduce(function (a, e) { return a + F.num(e.amount); }, 0)) : 0;
    return {
      code: r.code,
      label: r.label,
      count: count,
      total: total,
      totalText: F.fmt(total),
      on: !!(S.room && S.room.code === r.code)
    };
  });
}

/* ---------------- AI 配置（全局） ---------------- */
function readAiCfg() {
  const d = { preset: 'deepseek', base: F.AI_PRESETS.deepseek.base, model: F.AI_PRESETS.deepseek.model, key: '', jsonMode: false };
  const raw = safeGet(AI_CFG_KEY);
  if (raw && typeof raw === 'object') {
    return {
      preset: raw.preset || d.preset,
      base: raw.base || d.base,
      model: raw.model || d.model,
      key: raw.key || '',
      jsonMode: !!raw.jsonMode
    };
  }
  return d;
}
function writeAiCfg(cfg) {
  safeSet(AI_CFG_KEY, cfg);
}

module.exports = {
  ROOM_KEY_PREFIX, ROOMS_KEY, ROOM_MIGRATE_KEY, AI_CFG_KEY, ROOM_SCHEMA, ROOM_ALPHABET,
  get session() { return S; },
  bootRooms, save, switchRoom, newRoom, roomSummary,
  readRoom, writeRoom, readRoomMeta, writeRoomMeta, scanRoomCodes, normalizeRoomCode, genRoomCode,
  buildExportPayload, normalizeImport, applyImport,
  readAiCfg, writeAiCfg
};
