/**
 * cloudfunctions/_shared/validate.js
 * 入参校验：金额 / 名单 / 文案长度 / 日期 / 分页游标 / 房间码。
 * 所有校验失败都抛 AppError('INVALID', 中文提示)，由 createHandler 统一翻译。
 * 原则：服务端不信任客户端传来的任何数值与名字，尤其是分摊结果。
 */
var F = require('./finance.js');
var db = require('./db.js');

/* 去掉控制字符（含 \r），避免日志/数据库里出现不可见字符 */
var CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function bad(msg) {
  throw new db.AppError(db.ERR.INVALID, msg);
}

function cleanText(v, max) {
  var s = String(v === undefined || v === null ? '' : v)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL_RE, '')
    .trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

/** 名字/房间名这类单行文本：把连续空白压成一个空格 */
function oneLine(s) {
  return String(s || '').replace(/[ \t\n]+/g, ' ').trim();
}

/* ---------------- 基础字段 ---------------- */
function str(v, label, min, max) {
  var s = oneLine(cleanText(v, 0));
  if (!s) bad(label + '不能为空');
  if (min && s.length < min) bad(label + '至少 ' + min + ' 个字');
  if (max && s.length > max) bad(label + '不能超过 ' + max + ' 个字');
  return s;
}

function optionalStr(v, label, max) {
  var s = oneLine(cleanText(v, 0));
  if (!s) return '';
  if (max && s.length > max) bad(label + '不能超过 ' + max + ' 个字');
  return s;
}

function personName(v) {
  return str(v, '成员名', 1, 12);
}

function tryPersonName(v) {
  try {
    return personName(v);
  } catch (e) {
    return '';
  }
}

/** 房间名 2–16 字 */
function roomName(v) {
  return str(v, '房间名', 2, 16);
}

/** 账目项目名 ≤ 40 字 */
function item(v) {
  return str(v, '项目名', 1, 40);
}

/** 金额：0 < amount ≤ 1000000，最多两位小数（不做四舍五入，避免悄悄改数） */
function amount(v) {
  var n = Number(v);
  if (!isFinite(n)) bad('金额必须是数字');
  if (!(n > 0)) bad('金额要大于 0');
  if (n > 1000000) bad('金额不能超过 1000000');
  var cents = n * 100;
  if (Math.abs(Math.round(cents) - cents) > 1e-6) bad('金额最多两位小数');
  return F.num(n);
}

/** 日期 'YYYY-MM-DD'，并且要是真实存在的日子（2 月 30 号不行） */
function dateStr(v) {
  var s = cleanText(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) bad('日期要写成 YYYY-MM-DD');
  var y = Number(s.slice(0, 4));
  var m = Number(s.slice(5, 7));
  var d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) bad('日期不合法');
  var dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) bad('日期不合法');
  return s;
}

function tryDateStr(v) {
  try {
    return dateStr(v);
  } catch (e) {
    return '';
  }
}

/** 'YYYY-MM' */
function monthStr(v) {
  var s = cleanText(v, 7);
  if (!/^\d{4}-\d{2}$/.test(s)) bad('月份要写成 YYYY-MM');
  var m = Number(s.slice(5, 7));
  if (m < 1 || m > 12) bad('月份不合法');
  return s;
}

/** 房间码：大写去分隔符后必须正好 6 位、且都在字符表里 */
function roomCode(v) {
  var s = cleanText(v, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== db.ROOM_CODE_LEN) bad('房间码是 6 位字母数字');
  for (var i = 0; i < s.length; i++) {
    if (db.ROOM_ALPHABET.indexOf(s.charAt(i)) < 0) bad('房间码里有无效字符（只有 0 O 1 I l 不能用）');
  }
  return s;
}

/** 数据库文档 id（云开发自动 id 与自建 id 都是字母数字下划线短横线） */
function docId(v, label) {
  var s = cleanText(v, 0);
  if (!s) bad('缺少' + (label || '记录 ID'));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) bad((label || '记录 ID') + '格式不对');
  return s;
}

/** 幂等键：客户端生成，用来保证同一次记账只落一条 */
function clientId(v) {
  var s = cleanText(v, 0);
  if (!s) bad('缺少 clientId（用来防重复记账）');
  if (s.length > 64) bad('clientId 不能超过 64 个字符');
  if (!/^[A-Za-z0-9_\-:.]+$/.test(s)) bad('clientId 只能包含字母、数字和 _ - : .');
  return s;
}

/** 金额分摊方式 */
function mode(v) {
  var s = cleanText(v, 8).toLowerCase();
  if (!s) return 'equal';
  if (s !== 'equal' && s !== 'days') bad('分摊方式只能是 equal 或 days');
  return s;
}

/** 分类：不在预设里就按项目名猜（和客户端 guessCategory 同一套规则） */
function category(v, itemName) {
  var s = cleanText(v, 10);
  if (s) {
    if (F.CATEGORIES.indexOf(s) < 0) bad('分类不在预设范围里');
    return s;
  }
  return F.guessCategory(itemName || '');
}

/**
 * 分摊名单：[{name, weight}] 1–8 人，必须都是本房间 active 成员，不许重复。
 * weight 是「按天分摊」时每人的居住天数；equal 模式传 1 或不传。
 */
function participants(v, allowedNames) {
  if (!Array.isArray(v) || !v.length) bad('至少要有一个分摊人');
  if (v.length > 8) bad('分摊人最多 8 个');
  var out = [];
  var seen = {};
  for (var i = 0; i < v.length; i++) {
    var p = v[i];
    var rawName = (p && typeof p === 'object') ? p.name : p;
    var name = oneLine(cleanText(rawName, 0));
    if (!name) bad('分摊人名字不能为空');
    if (name.length > 12) bad('成员名不能超过 12 个字');
    if (seen[name]) bad('分摊人「' + name + '」重复了');
    seen[name] = true;
    if (allowedNames && allowedNames.indexOf(name) < 0) bad('「' + name + '」不是这个房间的成员');
    var w = 1;
    if (p && typeof p === 'object' && p.weight !== undefined && p.weight !== null && p.weight !== '') {
      w = Number(p.weight);
      if (!isFinite(w) || w <= 0) bad('分摊权重必须是大于 0 的数字');
      if (w > 100) bad('分摊权重不能超过 100');
      w = Math.round(w * 100) / 100;
    }
    out.push({ name: name, weight: w });
  }
  return out;
}

/** 单个成员名（payer 等） */
function memberName(v, allowedNames, label) {
  var name = oneLine(cleanText(v, 0));
  if (!name) bad((label || '成员名') + '不能为空');
  if (name.length > 12) bad('成员名不能超过 12 个字');
  if (allowedNames && allowedNames.indexOf(name) < 0) bad('「' + name + '」不是这个房间的成员');
  return name;
}

/** 小票结构化数据：只做体积与类型校验，避免把超大对象塞进单文档 */
function receipt(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'object' || Array.isArray(v)) bad('小票数据格式不对');
  var s = '';
  try {
    s = JSON.stringify(v);
  } catch (e) {
    bad('小票数据无法序列化');
  }
  if (s.length > 8000) bad('小票数据太大了（上限 8KB），请只保留明细');
  return v;
}

/** 原始一句话文案：超长直接截断（不影响账目本身） */
function rawText(v) {
  return cleanText(v, 500);
}

/** 头像 fileID：要么空，要么是云存储文件 */
function avatarFileID(v) {
  var s = cleanText(v, 0);
  if (!s) return '';
  if (s.length > 512) bad('头像 fileID 太长');
  if (s.indexOf('cloud://') !== 0) bad('头像必须是云存储文件');
  return s;
}

/** AI 识图上传的图片 fileID */
function fileID(v) {
  var s = cleanText(v, 0);
  if (!s) bad('缺少图片 fileID');
  if (s.length > 512) bad('fileID 太长');
  if (s.indexOf('cloud://') !== 0) bad('fileID 必须是云存储文件');
  return s;
}

/** 分页条数：默认 30，最大 100 */
function limit(v, def, max) {
  var n = Number(v);
  if (!isFinite(n) || n <= 0) return def || 30;
  n = Math.floor(n);
  var cap = max || 100;
  return n > cap ? cap : n;
}

/** 列表筛选：all=全部，open=还有没结清的分摊 */
function filter(v) {
  var s = cleanText(v, 10).toLowerCase();
  if (!s) return 'all';
  if (s !== 'all' && s !== 'open') bad('filter 只能是 all 或 open');
  return s;
}

/** 更新补丁必须是普通对象（具体允许哪些字段由业务函数决定） */
function patchObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad('patch 必须是一个对象');
  return v;
}

/* ---------------- 游标分页 ---------------- */
/** 游标 = base64({ d:date, t:createdAt, i:_id })，按 date desc, createdAt desc, _id desc 续读 */
function encodeCursor(obj) {
  if (!obj) return '';
  try {
    return Buffer.from(JSON.stringify(obj), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch (e) {
    return '';
  }
}

function decodeCursor(s) {
  if (!s) return null;
  var t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  try {
    var obj = JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (typeof obj.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.d)) return null;
    if (!isFinite(Number(obj.t)) || !obj.i) return null;
    return { d: obj.d, t: Number(obj.t), i: String(obj.i) };
  } catch (e) {
    return null;
  }
}

module.exports = {
  bad: bad,
  cleanText: cleanText,
  oneLine: oneLine,
  str: str,
  optionalStr: optionalStr,
  personName: personName,
  tryPersonName: tryPersonName,
  roomName: roomName,
  item: item,
  amount: amount,
  dateStr: dateStr,
  tryDateStr: tryDateStr,
  monthStr: monthStr,
  roomCode: roomCode,
  docId: docId,
  clientId: clientId,
  mode: mode,
  category: category,
  participants: participants,
  memberName: memberName,
  receipt: receipt,
  rawText: rawText,
  avatarFileID: avatarFileID,
  fileID: fileID,
  limit: limit,
  filter: filter,
  patchObject: patchObject,
  encodeCursor: encodeCursor,
  decodeCursor: decodeCursor
};
