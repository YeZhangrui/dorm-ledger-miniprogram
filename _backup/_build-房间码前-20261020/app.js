"use strict";
/* =========================================================================
   寝室公共开支智能记账与分摊提醒 —— 前端 demo
   · 成员可配置：2–8 人，可增删改、可切换“当前记账人”（右上角 👥 成员）
   · 小票识别：票面文字 → 明细行 → 逐行核对 → 分摊入账
     样例小票的文字由本机「屏幕扫描助手」（RapidOCR PP-OCRv6，离线）真实识别得到
   · 全部逻辑本地运行，不联网；localStorage 持久化（成员设置一起保存）
   ========================================================================= */

/* ---------------- 基础配置 ---------------- */
var STORE_KEY = "dorm-ledger-demo-v3";
var OLD_KEYS = ["dorm-ledger-demo-v2", "dorm-ledger-demo-v1"];
var DEFAULT_MEMBERS = ["陈默", "李昊", "王雨", "赵小满"];
var MIN_MEMBERS = 2, MAX_MEMBERS = 8;
var ALIAS = { "老王": "王雨", "小雨": "王雨", "昊子": "李昊", "默默": "陈默", "小满": "赵小满", "老李": "李昊" };
var NICK = { "陈默": "默默", "李昊": "昊子", "王雨": "小雨", "赵小满": "小满" };
var CN_NUM = { "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
var CN_WORD = { 2: "两", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八" };
var CAT_ICON = { "饮用水": "💧", "电费": "⚡", "网费": "🌐", "日用品": "🧻", "食品": "🍪", "维修": "🔧", "其他": "🧾" };

/* 样例数据已移除：识图交给 AI 多模态模型或手动粘贴的票面文字 */

/* ---------------- 状态与存储 ---------------- */
var state = {
  members: DEFAULT_MEMBERS.slice(),
  me: DEFAULT_MEMBERS[0],
  expenses: [],
  filter: "all",
  draft: null,
  editRows: null,
  rdraft: null,
  heroCompact: false
};

function seed() {
  var M = state.members, N = M.length, mk = monthKey();
  var pick = function (i) { return M[((i % N) + N) % N]; };
  var plan = [
    { d: "01", item: "网费",           cat: "网费",   amount: 120.00, payer: 0, open: [] },
    { d: "03", item: "桶装水、垃圾袋", cat: "日用品", amount: 36.60,  payer: 1, open: [2] },
    { d: "05", item: "电费",           cat: "电费",   amount: 86.40,  payer: 0, open: [1] },
    { d: "06", item: "公共零食",       cat: "食品",   amount: 45.00,  payer: 2, open: [] },
    { d: "08", item: "微波炉维修",     cat: "维修",   amount: 60.00,  payer: 3, open: [0] },
    { d: "09", item: "洗洁精、洗衣液", cat: "日用品", amount: 7.20,   payer: 1, open: [0, 3] }
  ];
  return plan.map(function (p, idx) {
    var payer = pick(p.payer);
    var settled = {};
    M.forEach(function (m) { settled[m] = true; });
    p.open.forEach(function (i) { var nm = pick(i); if (nm !== payer) settled[nm] = false; });
    return {
      id: "e" + (idx + 1), date: mk + "-" + p.d, item: p.item, category: p.cat, amount: p.amount,
      payer: payer, mode: "equal", source: "nl",
      participants: M.map(function (m) { return { name: m }; }),
      settled: settled,
      raw: "（演示数据）" + p.item + " " + p.amount + " 元，" + cnWord(N) + "个人分"
    };
  });
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      v: 3, members: state.members, me: state.me, expenses: state.expenses
    }));
  } catch (e) { /* 隐私模式下退化为内存存储 */ }
}

function load() {
  var keys = [STORE_KEY].concat(OLD_KEYS);
  for (var k = 0; k < keys.length; k++) {
    try {
      var raw = localStorage.getItem(keys[k]);
      if (!raw) continue;
      var o = JSON.parse(raw);
      if (Array.isArray(o)) {                       // v1：只有账目数组
        if (o.length) { state.members = DEFAULT_MEMBERS.slice(); state.me = state.members[0]; return o; }
        continue;
      }
      if (o && Array.isArray(o.expenses)) {
        if (Array.isArray(o.members) && o.members.length >= MIN_MEMBERS) {
          state.members = o.members.slice(0, MAX_MEMBERS);
          state.me = (o.me && state.members.indexOf(o.me) >= 0) ? o.me : state.members[0];
        }
        return o.expenses;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

/* ---------------- 工具函数 ---------------- */
function fmt(n) { return "¥" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
function num(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function cnWord(n) { return CN_WORD[n] || String(n); }
function pad2(x) { return String(x).padStart(2, "0"); }
function todayStr() {
  var d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function monthKey() { return todayStr().slice(0, 7); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function moneySpeech(n) {
  var v = num(n), yuan = Math.floor(v), rest = Math.round((v - yuan) * 100), jiao = Math.floor(rest / 10), fen = rest % 10;
  var s = yuan + " 块";
  if (jiao) s += " " + jiao + " 毛";
  if (fen) s += " " + fen;
  return s;
}
function nick(name) { return NICK[name] || name; }
function toast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toast._h);
  toast._h = setTimeout(function () { t.classList.remove("on"); }, 2200);
}
function uid() { return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function knownPeople(expenses) {
  var set = state.members.slice();
  (expenses || state.expenses).forEach(function (e) {
    if (set.indexOf(e.payer) < 0) set.push(e.payer);
    (e.participants || []).forEach(function (p) { if (set.indexOf(p.name) < 0) set.push(p.name); });
  });
  return set;
}
function isExMember(name) { return state.members.indexOf(name) < 0; }
function guessCategory(text) {
  for (var i = 0; i < CAT_RULES.length; i++) { if (CAT_RULES[i].re.test(String(text || ""))) return CAT_RULES[i].cat; }
  return "其他";
}

/* ---------------- 核心：分摊计算（含尾差处理） ---------------- */
function computeShares(amount, parts) {
  var total = num(amount);
  if (!parts.length) return [];
  var sumW = parts.reduce(function (s, p) { return s + (Number(p.weight) > 0 ? Number(p.weight) : 1); }, 0);
  var out = [], acc = 0;
  for (var i = 0; i < parts.length; i++) {
    var w = Number(parts[i].weight) > 0 ? Number(parts[i].weight) : 1;
    var share;
    if (i === parts.length - 1) share = num(total - acc);
    else { share = num(total * w / sumW); acc = num(acc + share); }
    out.push({ name: parts[i].name, weight: w, share: share, tail: false });
  }
  var diff = num(total - out.reduce(function (s, p) { return s + p.share; }, 0));
  if (diff !== 0) { out[out.length - 1].share = num(out[out.length - 1].share + diff); out[out.length - 1].tail = true; }
  else if (Math.abs(num(total) * 100 % parts.length) > 0) out[out.length - 1].tail = true;
  return out;
}

function balances(expenses) {
  var people = knownPeople(expenses), map = {};
  people.forEach(function (m) { map[m] = { name: m, paid: 0, owed: 0, ex: isExMember(m) }; });
  expenses.forEach(function (e) {
    var shares = e.shares || computeShares(e.amount, e.participants);
    if (map[e.payer]) map[e.payer].paid = num(map[e.payer].paid + num(e.amount));
    shares.forEach(function (p) {
      if (!map[p.name]) map[p.name] = { name: p.name, paid: 0, owed: 0, ex: true };
      map[p.name].owed = num(map[p.name].owed + p.share);
    });
  });
  return people.map(function (m) {
    return { name: m, paid: map[m].paid, owed: map[m].owed, net: num(map[m].paid - map[m].owed), ex: map[m].ex };
  });
}

function unsettled(expenses) {
  var dirs = {};
  expenses.forEach(function (e) {
    var shares = e.shares || computeShares(e.amount, e.participants);
    shares.forEach(function (p) {
      if (p.name === e.payer) return;
      if (e.settled && e.settled[p.name]) return;
      var key = p.name + ">" + e.payer;
      if (!dirs[key]) dirs[key] = { from: p.name, to: e.payer, amount: 0, items: [] };
      dirs[key].amount = num(dirs[key].amount + p.share);
      dirs[key].items.push({ id: e.id, item: e.item, amount: p.share, date: e.date });
    });
  });
  var out = [], seen = {};
  Object.keys(dirs).forEach(function (k) {
    if (seen[k]) return;
    seen[k] = true;
    var d = dirs[k], revKey = d.to + ">" + d.from, rev = dirs[revKey];
    if (!rev) { out.push({ from: d.from, to: d.to, amount: d.amount, offset: 0, items: d.items }); return; }
    seen[revKey] = true;
    var net = num(d.amount - rev.amount);
    if (net > 0) out.push({ from: d.from, to: d.to, amount: net, offset: rev.amount, items: d.items, offsetItems: rev.items });
    else if (net < 0) out.push({ from: rev.from, to: rev.to, amount: num(-net), offset: d.amount, items: rev.items, offsetItems: d.items });
  });
  return out.sort(function (a, b) { return b.amount - a.amount; });
}

function unsettledItems(expenses) {
  var out = [];
  expenses.forEach(function (e) {
    var shares = e.shares || computeShares(e.amount, e.participants);
    shares.forEach(function (p) {
      if (p.name === e.payer) return;
      if (e.settled && e.settled[p.name]) return;
      out.push({ expenseId: e.id, debtor: p.name, creditor: e.payer, share: p.share, item: e.item, date: e.date });
    });
  });
  return out;
}

function settlePair(expenses, a, b) {
  expenses.forEach(function (e) {
    var shares = computeShares(e.amount, e.participants);
    shares.forEach(function (p) {
      if (p.name === e.payer) return;
      if ((p.name === a && e.payer === b) || (p.name === b && e.payer === a)) {
        e.settled = e.settled || {};
        e.settled[p.name] = true;
      }
    });
    e.shares = shares;
  });
}

function renameMember(oldName, newName) {
  var i = state.members.indexOf(oldName);
  if (i >= 0) state.members[i] = newName;
  if (state.me === oldName) state.me = newName;
  state.expenses.forEach(function (e) {
    if (e.payer === oldName) e.payer = newName;
    (e.participants || []).forEach(function (p) { if (p.name === oldName) p.name = newName; });
    if (e.settled && Object.prototype.hasOwnProperty.call(e.settled, oldName)) {
      e.settled[newName] = e.settled[oldName];
      delete e.settled[oldName];
    }
    if (e.shares) e.shares.forEach(function (p) { if (p.name === oldName) p.name = newName; });
  });
}

/* =========================================================================
   AI 能力 ①：自然语言 → 结构化账目（demo 用规则模拟，正式版换成大模型 API）
   ========================================================================= */
var CAT_RULES = [
  { cat: "饮用水", re: /(桶装水|矿泉水|饮水|买水|水)/ },
  { cat: "电费", re: /(电费|空调|热水器|电)/ },
  { cat: "网费", re: /(网费|宽带|路由器|wifi|无线网)/i },
  { cat: "日用品", re: /(纸巾|卫生纸|抽纸|纸|垃圾袋|洗洁精|洗衣液|洁厕灵|牙膏|日用品|水桶)/ },
  { cat: "食品", re: /(零食|水果|橙子|苹果|香蕉|小吃|菜|外卖|吃|饮料)/ },
  { cat: "维修", re: /(维修|修|换新|上门费)/ }
];

function parseExpense(text) {
  var raw = String(text || "").trim();
  var M = state.members, N = M.length, me = state.me;
  var res = { ok: false, raw: raw, amount: 0, item: "", category: "其他", payer: me,
              parts: M.slice(), mode: "equal", confidence: 0.5, warnings: [] };
  if (!raw) { res.warnings.push("还没输入内容"); return res; }

  var t = raw.replace(/\s+/g, "");
  var signals = 0;

  t = t.replace(/(\d{1,2})月(\d{1,2})?日?/g, "");
  var declaredCount = 0;
  t = t.replace(/([一两二三四五六七八九]|\d+)(个?人|位|名|天)/g, function (_all, cnt) {
    var v = CN_NUM[cnt] || parseInt(cnt, 10) || 0;
    if (v && v <= 8 && !declaredCount) declaredCount = v;
    return "";
  });
  if (/我们仨|仨人/.test(t)) { declaredCount = declaredCount || 3; t = t.replace(/我们仨|仨人/g, ""); }

  var amount = null, m;
  if ((m = t.match(/(\d+)\s*(?:块|元)\s*([0-9])(?!\d)/))) amount = parseFloat(m[1] + "." + m[2]);
  else if ((m = t.match(/(\d+(?:\.\d{1,2})?)\s*(?:块|元|块钱)/))) amount = parseFloat(m[1]);
  else {
    var dec = t.match(/\d+\.\d{1,2}/);
    if (dec) amount = parseFloat(dec[0]);
    else {
      var allNum = t.match(/\d+/g) || [];
      if (allNum.length) amount = Math.max.apply(null, allNum.map(Number));
    }
  }
  if (amount != null && isFinite(amount) && amount > 0) { res.amount = num(amount); signals++; }
  else res.warnings.push("没听出金额，补一句“多少钱”就行");

  var itemLabel = "";
  res.category = guessCategory(raw);
  var itemMatch = raw.match(/(?:买|垫了|付了|交了|花了|充了|维修|修)([^0-9，,。.、]{1,10})/);
  if (itemMatch && itemMatch[1]) {
    itemLabel = itemMatch[1].replace(/([一两二三四五六七八九])?个?人|我们|全寝室|平摊|均摊|分|AA/g, "").trim();
  }
  if (!itemLabel) itemLabel = res.category === "其他" ? "" : res.category;
  res.item = itemLabel || "公共开支";
  if (itemLabel && itemLabel.length <= 2 && res.category !== "其他") res.item = res.category;
  if (itemLabel) signals++;

  var payersFound = [];
  Object.keys(ALIAS).forEach(function (a) { if (raw.indexOf(a) >= 0 && M.indexOf(ALIAS[a]) >= 0) payersFound.push(ALIAS[a]); });
  M.forEach(function (m2) { if (raw.indexOf(m2) >= 0) payersFound.push(m2); });
  var hasPayVerb = /(垫|先付|付了|买|出了|我出)/.test(raw);
  if (payersFound.length && hasPayVerb && /(垫|先付|付了|出)/.test(raw)) {
    res.payer = payersFound[0]; signals++;
    if (res.payer !== me) res.warnings.push("垫付人识别为 " + res.payer + "，请核对");
  } else res.payer = me;

  var parts = M.slice();
  var exclMe = /除了\s*(我|自己)|不含我|不算我/.test(raw);
  var pairMatch = raw.match(/我和([\u4e00-\u9fa5]{2,4})(?:分|平摊|均摊|AA)/);
  if (exclMe) {
    parts = M.filter(function (m3) { return m3 !== me; }); signals++;
    res.warnings.push("识别为“除我之外”，已排除 " + me);
  } else if (pairMatch) {
    var who = pairMatch[1];
    var whoName = (ALIAS[who] && M.indexOf(ALIAS[who]) >= 0) ? ALIAS[who] : (M.indexOf(who) >= 0 ? who : null);
    if (whoName) { parts = [me, whoName]; signals++; } else res.warnings.push("“" + who + "”不在成员名单里，请手动勾选参与人");
  } else if (declaredCount && declaredCount !== N) {
    parts = M.slice();
    res.warnings.push("句子里说 " + declaredCount + " 人，寝室是 " + N + " 人，已先按全部成员分摊，请核对参与人（可在 👥 成员里改人数）");
  } else if (declaredCount === N || /全寝室|全寝|所有人|平摊|均摊|AA/.test(raw)) { parts = M.slice(); signals++; }
  if (parts.indexOf(res.payer) < 0 && parts.length && !exclMe) {
    res.warnings.push("垫付人 " + res.payer + " 不在参与人里，请核对是否不用他分摊");
  }
  res.parts = parts;

  if (/按天|居住天数|住了几天/.test(raw)) { res.mode = "days"; res.warnings.push("按居住天数分摊，请填写每人天数"); }
  if (/我请|不用还|请客/.test(raw)) res.warnings.push("检测到“请客”语气，本笔仍按分摊入账，可手动改为不分摊");

  res.confidence = Math.min(0.98, 0.55 + signals * 0.11);
  res.ok = res.amount > 0 && parts.length >= 1;
  return res;
}

/* =========================================================================
   AI 能力 ②：小票文字 → 明细行（换行/空格/表格都能吃）
   读图部分由 OCR 负责（本机离线引擎或云端），这里只负责“认得懂”
   ========================================================================= */
function parseReceiptText(text) {
  var raw = String(text || "").replace(/\r/g, "");
  var lines = raw.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
  var out = { merchant: "", date: "", total: 0, sum: 0, totals: [], lines: [], warnings: [], confidence: 0.5, raw: raw };
  if (!lines.length) { out.warnings.push("没有可识别的文字，请粘贴票面内容"); return out; }

  var DATE_RE = /(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/;
  var TOTAL_RE = /(合计|总计|实收|应付|应收|金额)/;
  var TOTAL_BAD = /(优惠|折扣|减免|找零|积分|支付)/;
  var HEADER_RE = /^(商品名|品名|名称|数量|单价|小计|总额|金额|备注|项目)$/;
  var NOISE_RE = /(存到相册|找相似图|找高清图|问这张图|查看原网页|有图有真相|购物小票|\d+\s*px|^更多$|^小票)/i;
  var SKIP_RE = /(合计|总计|实付|应付|应收|找零|收银|单号|流水|账单|机号|桌号|人数|件数|会员|扫码|微信|支付宝|支付|发票|税|谢谢|欢迎|电话|地址|门店|时间|服务员|数量|单价|小计|总额|原价|现价|优惠|折扣|减免)/;

  var pendingName = "";
  lines.forEach(function (ln) {
    /* 网页截图带出来的页码/按钮/电话等噪声，直接丢掉，并且不参与跨行合并 */
    if (/^\d{1,2}\s*\/\s*\d{1,2}$/.test(ln) || NOISE_RE.test(ln) || /^1\d{10}$/.test(ln)) { pendingName = ""; return; }

    var dm = ln.match(DATE_RE);
    if (dm && !out.date) out.date = dm[1] + "-" + pad2(dm[2]) + "-" + pad2(dm[3]);

    var am = ln.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*(?:元)?\s*$/);
    var trailing = am ? am[1] : "";

    /* 票面总额候选（合计/实收/金额），但排除优惠、找零、支付方式里的数字 */
    if (TOTAL_RE.test(ln) && !TOTAL_BAD.test(ln)) {
      var tv = parseFloat(trailing);
      if (tv > 0) out.totals.push(num(tv));
      return;
    }
    if (SKIP_RE.test(ln) || HEADER_RE.test(ln)) { pendingName = ""; return; }

    /* 没有两位小数金额的行：当商家名或“待合并的商品名”（真实小票常把名称和金额分成两行） */
    if (!am || trailing.indexOf(".") < 0) {
      var cleanTxt = ln.replace(/^[【\[]+|[】\]]+$/g, "").trim();
      if (/^[+\-=_\s]+$/.test(cleanTxt)) return;
      if (!out.merchant && !/\d/.test(cleanTxt) && cleanTxt.length >= 2) {   // 商家名行不当商品名
        out.merchant = cleanTxt; pendingName = ""; return;
      }
      if (!/\d/.test(cleanTxt) && cleanTxt.length >= 2 && cleanTxt.length <= 14) pendingName = cleanTxt;
      return;
    }

    var amount = parseFloat(trailing);
    if (!(amount > 0)) return;
    var head = ln.slice(0, ln.length - am[0].length).trim()
                 .replace(/^[x×*]\s*\d+\s*/i, "")
                 .replace(/[x×*]\s*\d+\s*$/gi, "");
    var prev;
    do { prev = head; head = head.replace(/(?:^|\s)\d+(?:\.\d+)?\s*$/g, "").trim(); } while (head !== prev);

    var digitsOnly = /^[\d.\s]*$/.test(head);          // 空行或纯条码/数量列都算“不是商品”
    if (digitsOnly && !pendingName) return;              // 纯条码/重量/数量行，不是商品
    var name = digitsOnly ? pendingName : (head || pendingName || "");
    pendingName = "";
    if (!name) name = "未识别项目";
    out.lines.push({
      name: name, amount: num(amount),
      conf: num(name === "未识别项目" ? 0.45 : 0.62 + (name.length >= 2 ? 0.2 : 0) + 0.13)
    });
  });

  out.merchant = out.merchant || lines[0];
  out.confidence = out.lines.length
    ? num(out.lines.reduce(function (s, l) { return s + Math.max(0.3, l.conf); }, 0) / out.lines.length)
    : 0.35;
  return finishReceipt(out);
}

/* =========================================================================
   AI 能力 ③：催缴话术生成（demo 用模板+变量，正式版用大模型按关系生成）
   ========================================================================= */
function makeReminder(debtor, creditor, amount, items, tone, offset) {
  var nn = nick(debtor), cn = nick(creditor);
  var itemTxt = items.slice(0, 2).map(function (x) { return x.item; }).join("、") + (items.length > 2 ? "等" : "");
  var n = items.length;
  var speech = moneySpeech(amount);
  var off = Number(offset) > 0 ? "（我这边欠你的 " + fmt(offset) + " 已经帮你扣掉了）" : "";
  if (tone === "fun") {
    return "【寝室公共基金催缴通知】" + nn + " 同学：\n" +
      "经查，你在「" + itemTxt + "」等 " + n + " 笔公共开支中还差 " + fmt(amount) + "（" + speech + "）没到位 😂" +
      (off ? "\n（反向欠款已自动对冲，" + fmt(offset) + "，不用你算）" : "") + "\n" +
      "基金缺口已影响下批零食采购计划，" + cn + " 同学表示理解并保持关注。\n" +
      "转账入口：点这里 →" + cn + " 的收款码（不催不催，就是提醒一下）";
  }
  if (tone === "direct") {
    return nn + "，" + itemTxt + "+ 共 " + n + " 笔公共开支你这边还有 " + fmt(amount) + " 没结" + off + "，方便的时候转我一下，谢谢～";
  }
  return nn + "～" + itemTxt + "那几笔加起来是 " + fmt(amount) + "（" + speech + "）" + off + "，你要是方便的时候转我下就行，不急～";
}

/* AI 能力 ④：月度报告（统计 + 文案） */
function makeReport(expenses) {
  var mk = monthKey(), N = state.members.length;
  var list = expenses.filter(function (e) { return (e.date || "").slice(0, 7) === mk; });
  var use = list.length ? list : expenses;
  var total = num(use.reduce(function (s, e) { return s + num(e.amount); }, 0));
  var per = N ? num(total / N) : 0;
  var byCat = {};
  use.forEach(function (e) { byCat[e.category] = num((byCat[e.category] || 0) + num(e.amount)); });
  var cats = Object.keys(byCat).map(function (k) { return { cat: k, amount: byCat[k] }; })
    .sort(function (a, b) { return b.amount - a.amount; });
  var open = unsettled(use);
  var openTotal = num(open.reduce(function (s, x) { return s + x.amount; }, 0));
  var closedRatio = total ? Math.round((1 - openTotal / total) * 100) : 100;
  var lines = [];
  lines.push("本月公共开支共 " + fmt(total) + "，" + use.length + " 笔，" + N + " 人人均 " + fmt(per) + "，平均每笔 " + fmt(use.length ? total / use.length : 0) + "。");
  if (cats.length) lines.push("支出最多的类别是「" + cats[0].cat + "」，" + fmt(cats[0].amount) + "，占 " + Math.round(cats[0].amount / (total || 1) * 100) + "%；" + (cats[1] ? "其次是「" + cats[1].cat + "」（" + fmt(cats[1].amount) + "）。" : ""));
  lines.push("目前结清进度 " + closedRatio + "%" + (openTotal > 0
    ? "，还有 " + fmt(openTotal) + " 待结清，涉及 " + open.length + " 个组合，建议用“催缴提醒”一键发出。"
    : "，全部结清，寝室财务健康 👍"));
  if (cats.length && cats[0].cat === "电费" && cats[0].amount / (total || 1) > 0.2) lines.push("提示：电费占比较高（夏季空调为主要变量），可约定空调 26℃ 与睡前定时，预计能降一成。");
  lines.push("建议：饮用水与日用品属于小额高频，可约定“谁顺手谁买、买完一句话记账”，减少反复垫付。");
  return { total: total, per: per, count: use.length, cats: cats, open: open, openTotal: openTotal,
           closedRatio: closedRatio, text: lines.join("\n") };
}

/* =========================================================================
   AI 能力 ⑤：多模态识图（OpenAI 兼容协议，浏览器直连或走本机代理）
   说明：Key 只存在本机 localStorage，不写进本页；正式上线必须走服务端代理（见 ai_proxy.py）
   ========================================================================= */
var AI_CFG_KEY = "dorm-ledger-ai-v1";
var AI_PRESETS = {
  "deepseek":  { label: "DeepSeek（deepseek-flash，支持图片）", base: "https://api.deepseek.com", model: "deepseek-flash" },
  "dashscope": { label: "通义千问（阿里云 DashScope）", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-max-latest" },
  "zhipu":     { label: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4v-plus" },
  "volc":      { label: "火山方舟（豆包）", base: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-1.5-vision-pro" },
  "openai":    { label: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  "proxy":     { label: "本机代理（Key 不落浏览器）", base: "http://127.0.0.1:8765/v1", model: "qwen-vl-max-latest" },
  "custom":    { label: "自定义（OpenAI 兼容）", base: "", model: "" }
};
var AI_PROMPT = "你是寝室公共开支记账助手。请识别这张小票图片，只输出一个 JSON 对象，不要解释、不要 markdown 代码块：\n" +
  '{"merchant":"商家名","date":"YYYY-MM-DD","total":票面总额,"lines":[{"name":"商品名","qty":1,"amount":金额}]}\n' +
  "要求：1) 金额一律为数字，不带货币符号；2) date 取票面日期，识别不到填空字符串；" +
  "3) lines 只放真正购买的商品或服务，不要包含合计、找零、支付方式、会员、页眉页脚，也不要包含截图里的按钮文字（如“存到相册”“找相似图”）。";
var aiCfg = { preset: "deepseek", base: AI_PRESETS.deepseek.base, model: AI_PRESETS.deepseek.model, key: "" };

function loadAiCfg() {
  try {
    var raw = localStorage.getItem(AI_CFG_KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && typeof o === "object") {
        aiCfg.preset = o.preset || aiCfg.preset;
        aiCfg.base = o.base || aiCfg.base;
        aiCfg.model = o.model || aiCfg.model;
        aiCfg.key = o.key || "";
      }
    }
  } catch (e) { /* 无 localStorage 时用默认预设 */ }
  return aiCfg;
}
function saveAiCfg() {
  try { localStorage.setItem(AI_CFG_KEY, JSON.stringify(aiCfg)); } catch (e) { /* ignore */ }
}
function aiConfigured() { return !!(aiCfg.base && aiCfg.model); }

/* 从模型回复里抠出第一个完整的 JSON 对象（容忍 ```json 包裹与前后废话） */
function extractJsonFromText(text) {
  var s = String(text || "").replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "");
  var start = s.indexOf("{");
  if (start < 0) return null;
  var depth = 0, inStr = false, escaped = false;
  for (var i = start; i < s.length; i++) {
    var c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/* 统一的收尾：算明细合计、比票面总额、给提示与置信度（本地 OCR 与 AI 识图共用） */
function finishReceipt(out) {
  if (!out.merchant) out.merchant = "未识别商家";
  if (!out.date) { out.date = todayStr(); out.warnings.push("没识别到日期，已按今天 " + out.date); }
  out.sum = num(out.lines.reduce(function (s, l) { return s + l.amount; }, 0));
  var distinct = out.totals.filter(function (v, i, a) { return a.indexOf(v) === i; });
  out.total = distinct.length ? distinct[0] : out.sum;
  if (distinct.length > 1) {
    out.warnings.push("票面出现多个不同的总额（" + distinct.map(fmt).join(" / ") + "），已取 " + fmt(out.total) + "，请核对是不是两单并排或有折扣");
  } else if (!out.totals.length && out.lines.length) {
    out.warnings.push("票面没识别到“合计/实收”行，已按明细加总 " + fmt(out.sum));
  }
  if (out.lines.length && Math.abs(out.sum - out.total) > 0.01) {
    out.warnings.push("明细合计 " + fmt(out.sum) + " 与票面总额 " + fmt(out.total) + " 相差 " + fmt(Math.abs(out.sum - out.total)) + "：可能有漏识别、折扣或抹零，请逐行核对");
  }
  if (!out.lines.length) out.warnings.push("没解析出明细行：请确认每行是“品名 金额”的格式，也可以手动补录");
  if (!out.confidence) out.confidence = out.lines.length ? 0.8 : 0.35;
  return out;
}

/* 把模型返回的 JSON 归一化成与本地 OCR 完全一致的结构 */
function normalizeAiReceipt(obj, provider, rawText) {
  var out = { merchant: "", date: "", total: 0, sum: 0, totals: [], lines: [], warnings: [],
              confidence: 0.9, raw: rawText || "", provider: provider || "AI 识图" };
  if (!obj) { out.warnings.push("模型没返回可解析的 JSON，请重试，或改用本机 OCR / 手动粘贴"); return finishReceipt(out); }
  out.merchant = String(obj.merchant || "").trim();
  var d = String(obj.date || "").trim();
  var dm = d.match(/(\d{4})\D{1,2}(\d{1,2})\D{1,2}(\d{1,2})/);
  if (dm) out.date = dm[1] + "-" + pad2(dm[2]) + "-" + pad2(dm[3]);
  var t = parseFloat(obj.total);
  if (t > 0) out.totals.push(num(t));
  (obj.lines || []).forEach(function (l) {
    var a = parseFloat(l && l.amount);
    if (!(a > 0)) return;
    var nm = String((l && l.name) || "").trim();
    out.lines.push({ name: nm || "未识别项目", qty: parseFloat((l && l.qty) || 1) || 1,
                     amount: num(a), conf: nm ? 0.92 : 0.5 });
  });
  return finishReceipt(out);
}

/* ---------------- 渲染 ---------------- */
function currentExpenses() {
  return state.expenses.slice().sort(function (a, b) { return (b.date + b.id) < (a.date + a.id) ? -1 : 1; });
}
function renderAll() {
  var list = currentExpenses();
  renderTop(); renderSamples(); renderHero(list); renderHome(list);
  renderList(list); renderRemind(list); renderReport(list);
}

/* 头部收起 / 展开：手机默认收起（省出首屏），用户选择会被记住 */
var HERO_KEY = "dorm-hero-compact-v1";
function heroIsCompact() {
  try {
    var v = localStorage.getItem(HERO_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch (e) { /* 无 localStorage 时按屏幕宽度判断 */ }
  var w = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 9999;
  return w <= 520;
}
function applyHero(compact) {
  state.heroCompact = !!compact;
  var tb = document.querySelector(".topbar");
  if (tb) tb.classList.toggle("min", state.heroCompact);
  var b = document.getElementById("btnHero");
  if (b) {
    b.textContent = state.heroCompact ? "⌄" : "⌃";
    b.title = state.heroCompact ? "展开头部" : "收起头部";
  }
  try { localStorage.setItem(HERO_KEY, state.heroCompact ? "1" : "0"); } catch (e) { /* ignore */ }
  if (typeof renderTop === "function") renderTop();
}

function renderTop() {
  document.getElementById("topDorm").textContent = state.members.length + " 人寝室" +
    (state.heroCompact ? "" : " · 公共开支台账");
  document.getElementById("topStatus").textContent = "当前记账人：" + state.me;
  document.getElementById("bookWho").textContent = "记账人：" + state.me;
  document.getElementById("nlInput").placeholder = "例：今天买水 12.4 " + cnWord(state.members.length) + "个人分";
}

function renderSamples() {
  var M = state.members, N = M.length, other = M[1] || M[0];
  var s = [
    "今天买水 12.4 " + cnWord(N) + "个人分",
    "我垫了网费 120，全寝室 AA",
    "电费 86 块 4，平摊",
    "空调电费我和" + other + "分，一共 60",
    N >= 3 ? "公共零食 45，除了我之外的" + cnWord(N - 1) + "个人分" : "公共零食 45，全寝室 AA"
  ];
  document.getElementById("sampleChips").innerHTML = s.map(function (x) {
    return '<span class="chip" data-chip="' + esc(x) + '">' + esc(x) + "</span>";
  }).join("");
}

function renderHero(list) {
  var mk = monthKey();
  var cur = list.filter(function (e) { return (e.date || "").slice(0, 7) === mk; });
  var use = cur.length ? cur : list;
  var total = num(use.reduce(function (s, e) { return s + num(e.amount); }, 0));
  var N = state.members.length;
  document.getElementById("heroTotal").textContent = fmt(total);
  document.getElementById("heroSub").textContent = "人均 " + fmt(N ? total / N : 0) + " · " + use.length +
    " 笔 · " + N + " 人";
  document.getElementById("heroMini").textContent = "本月 " + fmt(total) + " · 人均 " +
    fmt(N ? total / N : 0) + " · " + use.length + " 笔";
}

function renderHome(list) {
  var bals = balances(list);
  document.getElementById("homePeople").innerHTML = bals.map(function (b) {
    var cls = b.net >= 0 ? "pos" : "neg";
    var txt = b.net === 0 ? "已平" : (b.net > 0 ? "+" + fmt(b.net) : "-" + fmt(Math.abs(b.net)));
    return '<div class="person' + (b.ex ? " out" : "") + '"><span class="n">' + esc(b.name) +
      (b.ex ? '<span class="ex">已退出</span>' : "") + '</span><span class="b ' + cls + '">' + txt + "</span></div>";
  }).join("");

  var open = unsettled(list);
  var items = unsettledItems(list);
  var totalOpen = num(open.reduce(function (s, o) { return s + o.amount; }, 0));
  document.getElementById("unsettledCount").textContent = open.length ? open.length + " 组待结清（已抵消）" : "已全部结清";
  var box = document.getElementById("homeSettle");
  if (!open.length) box.innerHTML = '<div class="empty">没有未结清的账，寝室财务健康 👍</div>';
  else {
    box.innerHTML = open.map(function (o) {
      var detail = o.items.map(function (x) { return x.item + " " + fmt(x.amount); }).join(" · ");
      var off = o.offset > 0 ? '<div class="meta">已自动对冲反向欠款 ' + fmt(o.offset) + "，实收 " + fmt(o.amount) + "</div>" : "";
      return '<div class="rec"><div class="ico">💸</div><div class="mid">' +
        '<div class="title">' + esc(o.from) + " → " + esc(o.to) + "</div>" +
        '<div class="meta">' + esc(detail) + "</div>" + off + "</div>" +
        '<div><div class="amt" style="color:var(--danger)">' + fmt(o.amount) + "</div>" +
        '<button class="btn sm ghost" style="margin-top:4px" data-settle="' + esc(o.from) + "|" + esc(o.to) + '">标记已结清</button></div></div>';
    }).join("");
  }
  document.getElementById("homeAlert").innerHTML = totalOpen > 0
    ? '<div class="alert"><div>⚠️</div><div class="t">两两抵消后还有 <strong>' + fmt(totalOpen) + "</strong> 元没结清（原始 " + items.length +
      " 笔小额垫付在等回款）。金额不大，但<b>开口催最费劲</b>——去“提醒”让 AI 帮你说这句话。</div></div>"
    : "";
  document.getElementById("homeRecent").innerHTML = list.slice(0, 5).map(recHtml).join("") || '<div class="empty">还没有记录，去“记账”说一句吧</div>';
}

function recHtml(e) {
  var shares = e.shares || computeShares(e.amount, e.participants);
  var perTxt = shares.length ? "人均 " + fmt(shares[0].share) : "";
  var openN = unsettledItems([e]).filter(function (x) { return x.expenseId === e.id; }).length;
  var badge = openN === 0 ? '<span class="tag ok">已结清</span>' : '<span class="tag no">' + openN + " 人未结</span>";
  var src = e.source === "receipt" ? '<span class="tag rc">🧾 小票</span>' : "";
  return '<div class="rec"><div class="ico">' + (CAT_ICON[e.category] || "🧾") + "</div>" +
    '<div class="mid"><div class="title">' + esc(e.item) + badge + src + "</div>" +
    '<div class="meta">' + esc(e.date) + " · " + esc(e.payer) + " 垫付 · " + shares.length + " 人" +
    (e.mode === "days" ? "（按天数）" : "") + " · " + perTxt + "</div></div>" +
    '<div><div class="amt">' + fmt(e.amount) + "</div>" +
    (e.shares && e.shares.some(function (p) { return p.tail; }) ? '<div class="meta" style="text-align:right">含尾差</div>' : "") +
    "</div></div>";
}

function renderList(list) {
  var use = state.filter === "open" ? list.filter(function (e) { return unsettledItems([e]).length > 0; }) : list;
  var out = document.getElementById("listOut");
  if (!use.length) { out.innerHTML = '<div class="empty">' + (state.filter === "open" ? "没有未结清的记录" : "还没有记录") + "</div>"; return; }
  out.innerHTML = use.map(function (e) {
    var shares = e.shares || computeShares(e.amount, e.participants);
    var chips = shares.map(function (p) {
      var done = p.name === e.payer ? true : !!(e.settled && e.settled[p.name]);
      return '<span class="tag ' + (done ? "ok" : "no") + '" data-tog="' + e.id + "|" + esc(p.name) + '" title="点一下切换结清状态">' +
        esc(p.name) + (isExMember(p.name) ? "（已退出）" : "") + " " + fmt(p.share) + (done ? " ✓" : " 未结") + "</span>";
    }).join("");
    var src = e.source === "receipt"
      ? '<div class="muted" style="margin-bottom:6px">来源：🧾 小票识别' + (e.receipt && e.receipt.merchant ? "（" + esc(e.receipt.merchant) + "）" : "") + "</div>"
      : "";
    return '<div class="card"><h3><span>' + (CAT_ICON[e.category] || "🧾") + " " + esc(e.item) + '</span><span class="muted">' + esc(e.date) + "</span></h3>" +
      '<div class="muted" style="margin-bottom:6px">原始语句：“' + esc(e.raw || e.item) + "”</div>" + src +
      '<div class="field"><label>总额</label><div style="flex:1 1 auto;font-weight:700">' + fmt(e.amount) +
      '</div><span class="muted">' + esc(e.payer) + " 垫付</span></div>" +
      '<div style="margin:6px 0">' + chips + "</div>" +
      '<div class="rowbtns"><button class="btn sm ghost" data-clr="' + e.id + '">该笔全部结清</button>' +
      '<button class="btn sm danger" data-del="' + e.id + '">撤销这笔</button></div></div>';
  }).join("");
}

function renderRemind(list) {
  var sel = document.getElementById("rWho");
  var open = unsettled(list);
  var cur = sel.value;
  sel.innerHTML = open.length
    ? open.map(function (o) { return '<option value="' + esc(o.from) + "|" + esc(o.to) + '">' + esc(o.from) + " 欠 " + esc(o.to) + " " + fmt(o.amount) + "</option>"; }).join("")
    : '<option value="">（当前没有待结清）</option>';
  if (cur) { for (var i = 0; i < sel.options.length; i++) { if (sel.options[i].value === cur) { sel.selectedIndex = i; break; } } }
  syncWhoPicker();
}

function renderReport(list) {
  var r = makeReport(list);
  var bars = r.cats.map(function (c) {
    var pct = Math.round(c.amount / (r.total || 1) * 100);
    return '<div class="b"><div class="l"><span>' + (CAT_ICON[c.cat] || "🧾") + " " + esc(c.cat) + "</span><span>" + fmt(c.amount) + " · " + pct + '%</span></div><div class="bar"><i style="width:' + Math.max(3, pct) + '%"></i></div></div>';
  }).join("");
  document.getElementById("reportOut").innerHTML =
    '<div class="grid2" style="margin-bottom:12px">' +
      '<div class="stat"><div class="k">本月总额</div><div class="v">' + fmt(r.total) + "</div></div>" +
      '<div class="stat"><div class="k">人均（' + state.members.length + ' 人）</div><div class="v">' + fmt(r.per) + "</div></div>" +
      '<div class="stat"><div class="k">笔数</div><div class="v">' + r.count + "</div></div>" +
      '<div class="stat"><div class="k">结清进度</div><div class="v ' + (r.closedRatio >= 100 ? "pos" : "neg") + '">' + r.closedRatio + "%</div></div>" +
    "</div>" + '<div class="bars">' + bars + "</div>" +
    '<div class="quote" style="margin-top:6px">' + esc(r.text) + "</div>";
}

/* ---------------- 小票识别：界面 ---------------- */
function resetReceiptInput() {
  state.uploadFile = null;
  state.uploadDataUri = "";
  var f = document.getElementById("receiptFile");
  if (f) f.value = "";
  document.getElementById("receiptText").value = "";
  document.getElementById("uploadPreview").innerHTML = "";
  document.getElementById("scanHost").innerHTML = "";
  document.getElementById("fileName").textContent = "未选择文件（JPG / PNG 均可）";
}

function recognizeReceipt() {
  if (aiConfigured() && state.uploadDataUri) {
    runAiReceipt(state.uploadDataUri, state.uploadFile ? state.uploadFile.name : "上传的小票");
    return;
  }
  var txt = document.getElementById("receiptText").value;
  if (!txt.trim()) {
    toast(aiConfigured() ? "先选一张小票照片（或把票面文字粘到上方的文字框里）"
                         : "离线网页读不了图上的字：配好 AI 识图，或把票面文字粘到上方的文字框里");
    return;
  }
  var byText = parseReceiptText(txt);
  byText.provider = "手动粘贴的票面文字";
  applyReceiptDraft(byText);
}

function applyReceiptDraft(parsed) {
  parsed.lines.forEach(function (l) { l.use = true; });
  state.rdraft = parsed;
  state.rpayer = state.me;
  state.rparts = state.members.slice();
  if (!parsed.lines.length) { toast(parsed.warnings[0] || "没解析出明细行"); }
  renderReceiptResult();
  document.getElementById("receiptCard").style.display = "block";
  document.getElementById("receiptCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderReceiptResult() {
  var d = state.rdraft;
  if (!d) return;
  document.getElementById("rMerchant").textContent = d.merchant || "—";
  document.getElementById("rDate").textContent = d.date || "—";
  document.getElementById("rSum").textContent = fmt(d.sum);
  document.getElementById("rTotal").textContent = fmt(d.total);
  var lowN = d.lines.filter(function (l) { return l.conf < 0.8; }).length;
  document.getElementById("rconf").textContent = "来源：" + (d.provider || "手动粘贴的票面文字") +
    (lowN ? " · " + lowN + " 行建议核对" : "");
  document.getElementById("rWarn").innerHTML = d.warnings.length
    ? d.warnings.map(function (w) { return '<div class="alert"><div>🤖</div><div class="t">' + esc(w) + "</div></div>"; }).join("")
    : '<div class="alert ok"><div>✅</div><div class="t">明细与票面总额一致，核对后入账。</div></div>';

  document.getElementById("rPayer").innerHTML = state.members.map(function (m) {
    return '<option' + (m === state.rpayer ? " selected" : "") + ">" + esc(m) + "</option>";
  }).join("");
  document.getElementById("rParts").innerHTML = state.members.map(function (m) {
    var on = state.rparts.indexOf(m) >= 0;
    return '<div class="p' + (on ? " on" : "") + '" data-rpart="' + esc(m) + '"><span>' + (on ? "✓" : "＋") + "</span>" + esc(m) + "</div>";
  }).join("");

  document.getElementById("rLines").innerHTML = d.lines.map(function (l, i) {
    var low = l.conf < 0.8;
    return '<div class="rline" data-i="' + i + '">' +
      '<div class="ck' + (l.use ? " on" : "") + '" data-ruse="' + i + '">' + (l.use ? "✓" : "") + "</div>" +
      '<input type="text" data-rname="' + i + '" value="' + esc(l.name) + '" />' +
      '<input type="number" step="0.01" min="0" data-ramt="' + i + '" value="' + l.amount.toFixed(2) + '" />' +
      (low ? '<span class="tag low">请核对</span>' : "") +
      "</div>";
  }).join("") || '<div class="empty">没有解析出明细行</div>';

  var picked = d.lines.filter(function (l) { return l.use; });
  var payload = {
    merchant: d.merchant, date: d.date, receiptTotal: num(d.total),
    detailSum: num(d.sum), confidence: d.confidence,
    lines: picked.map(function (l) { return { name: l.name, qty: l.qty, amount: num(l.amount) }; }),
    payer: state.rpayer, participants: state.rparts.slice(),
    source: "receipt", warnings: d.warnings
  };
  document.getElementById("rJson").textContent =
    "// OCR 原始文字\n" + (d.raw || "（无）") + "\n\n// 解析结果（确认后才入账）\n" + JSON.stringify(payload, null, 2);
}

function receiptConfirm(mode) {
  var d = state.rdraft;
  if (!d) { toast("先识别一张小票"); return; }
  var picked = d.lines.filter(function (l) { return l.use && l.amount > 0; });
  if (!picked.length) { toast("至少要留一行明细"); return; }
  if (!state.rparts.length) { toast("至少留一个参与人"); return; }
  if (state.rparts.indexOf(state.rpayer) < 0) state.rparts.push(state.rpayer);

  var made = [];
  if (mode === "merge") {
    var amount = num(picked.reduce(function (s, l) { return s + l.amount; }, 0));
    var cat = guessCategory(picked.map(function (l) { return l.name; }).join(" "));
    if (cat === "其他") cat = "日用品";
    made.push({
      item: (d.merchant || "小票") + "（" + picked.length + " 项）", amount: amount, category: cat,
      raw: "小票识别：" + (d.merchant || "") + " " + picked.map(function (l) { return l.name + " " + l.amount.toFixed(2); }).join(" / ")
    });
  } else {
    picked.forEach(function (l) {
      made.push({ item: l.name, amount: num(l.amount), category: guessCategory(l.name), raw: "小票识别：" + (d.merchant || "") + " " + l.name });
    });
  }

  /* 倒序插入：明细列表按时间倒序，这样同一天的小票明细会保持票面原始顺序 */
  made.slice().reverse().forEach(function (rec) {
    var participants = state.rparts.map(function (m) { return { name: m }; });
    var settled = {};
    participants.forEach(function (p) { settled[p.name] = p.name === state.rpayer; });
    var full = {
      id: uid(), date: d.date || todayStr(), item: rec.item, category: rec.category, amount: rec.amount,
      payer: state.rpayer, mode: "equal", participants: participants, settled: settled,
      source: "receipt",
      receipt: {
        merchant: d.merchant, date: d.date, total: num(d.total), confidence: d.confidence, provider: d.provider || "",
        lines: picked.map(function (l) { return { name: l.name, amount: num(l.amount) }; })
      },
      raw: rec.raw
    };
    full.shares = computeShares(full.amount, full.participants);
    state.expenses.unshift(full);
  });

  save(); renderAll();
  document.getElementById("receiptCard").style.display = "none";
  state.rdraft = null;
  resetReceiptInput();
  toast((mode === "merge" ? "已合并入账 " : "已逐条入账 ") + made.length + " 笔 · 垫付人 " + state.rpayer);
  go("list");
}

/* ---------------- AI 识图：界面与调用 ---------------- */
function renderAiState() {
  var el = document.getElementById("aiState");
  if (!el) return;
  el.textContent = aiConfigured()
    ? "当前：" + aiCfg.model + " @ " + aiCfg.base + (aiCfg.key ? "（已填 Key）" : "（无 Key，走本机代理时正常）")
    : "还没配置，识图会用下面的本机 OCR 结果 / 粘贴文字";
  var p = document.getElementById("aiPreset");
  if (p) p.value = aiCfg.preset;
  var b = document.getElementById("aiBase"), m = document.getElementById("aiModel"), k = document.getElementById("aiKey");
  if (b) b.value = aiCfg.base;
  if (m) m.value = aiCfg.model;
  if (k) k.value = aiCfg.key;
  syncAiPresetPicker();
}
function syncAiPresetPicker() {
  var sel = document.getElementById("aiPreset");
  var trigger = document.getElementById("presetTrigger");
  var value = document.getElementById("presetValue");
  var menu = document.getElementById("presetMenu");
  if (!sel || !trigger || !value || !menu) return;
  var opt = sel.options[sel.selectedIndex];
  value.textContent = opt ? opt.textContent : "选择服务商";
  menu.innerHTML = Array.prototype.map.call(sel.options, function (o) {
    var on = o.value === sel.value;
    return '<button type="button" class="preset-option' + (on ? " on" : "") + '" role="option" aria-selected="' + (on ? "true" : "false") + '" data-preset="' + esc(o.value) + '">' + esc(o.textContent) + "</button>";
  }).join("");
}
function closePresetMenu(focusBack) {
  var trigger = document.getElementById("presetTrigger");
  var menu = document.getElementById("presetMenu");
  if (!trigger || !menu || menu.hidden) return;
  menu.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  if (focusBack !== false) trigger.focus();
}

function aiRecognize(dataUri) {
  var url = aiCfg.base.replace(/\/+$/, "") + "/chat/completions";
  var jm = document.getElementById("aiJsonMode");
  var headers = { "Content-Type": "application/json" };
  if (aiCfg.key) headers["Authorization"] = "Bearer " + aiCfg.key;
  var body = {
    model: aiCfg.model,
    temperature: 0,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: AI_PROMPT },
        { type: "image_url", image_url: { url: dataUri } }
      ]
    }]
  };
  if (jm && jm.checked) body.response_format = { type: "json_object" };   // DeepSeek 等支持 Json Output
  return fetch(url, { method: "POST", headers: headers, body: JSON.stringify(body) })
    .then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error("HTTP " + res.status + "：" + String(t).slice(0, 200)); });
      }
      return res.json();
    })
    .then(function (j) {
      var c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (Array.isArray(c)) c = c.map(function (x) { return x.text || ""; }).join("");
      if (!c) throw new Error("返回里没有 content 字段");
      return normalizeAiReceipt(extractJsonFromText(c), "AI 识图 · " + aiCfg.model, c);
    });
}

function runAiReceipt(dataUri, label) {
  var btn = document.getElementById("btnRecognize");
  btn.disabled = true;
  btn.textContent = "AI 读图中…";
  document.getElementById("receiptCard").style.display = "none";
  document.getElementById("scanHost").innerHTML = '<div class="muted" style="padding:10px 0">🤖 ' + esc(label) + "：多模态模型正在读图，请稍候…</div>";
  aiRecognize(dataUri).then(function (parsed) {
    btn.disabled = false;
    btn.textContent = "识别这张小票";
    document.getElementById("scanHost").innerHTML = "";
    if (!parsed.lines.length) toast(parsed.warnings[0] || "模型没读出明细，可改用本机 OCR 或手动粘贴");
    applyReceiptDraft(parsed);
  })["catch"](function (err) {
    btn.disabled = false;
    btn.textContent = "识别这张小票";
    document.getElementById("scanHost").innerHTML = "";
    var msg = String((err && err.message) || err);
    document.getElementById("rWarn").innerHTML = '<div class="alert"><div>⚠️</div><div class="t">AI 识图失败：' + esc(msg) +
      "<br>常见原因：Key/模型名不对、余额或额度不足、浏览器直连被 CORS 拦（改用“本机代理”预设 + ai_proxy.py）。也可以把票面文字粘到上方的文字框里继续。</div></div>";
    document.getElementById("receiptCard").style.display = "block";
    toast("AI 识图失败：" + msg.slice(0, 80));
  });
}
/* ---------------- 成员设置面板 ---------------- */
function openMembers() {
  state.editRows = state.members.map(function (m) { return { orig: m, name: m }; });
  renderMemberRows();
  document.getElementById("memberMask").classList.add("on");
}
function closeMembers() { document.getElementById("memberMask").classList.remove("on"); state.editRows = null; }

function renderMemberRows() {
  var rows = state.editRows || [];
  document.getElementById("memberCount").textContent = rows.length + " 人（2–8）";
  document.getElementById("memberRows").innerHTML = rows.map(function (r, i) {
    var isMe = (r.orig ? r.orig === state.me : false) ||
               (!r.orig && i === 0 && rows.every(function (x) { return x.orig; }));
    return '<div class="mrow" data-i="' + i + '" data-orig="' + esc(r.orig) + '">' +
      '<input type="text" value="' + esc(r.name) + '" maxlength="8" placeholder="成员名字" />' +
      '<label class="me"><input type="radio" name="mePick" value="' + i + '"' + (isMe ? " checked" : "") + " />当前记账人</label>" +
      '<button class="del" data-delrow="' + i + '" title="删除该成员">✕</button>' +
      "</div>";
  }).join("");
  var rowsEl = document.getElementById("memberRows");
  rowsEl.querySelectorAll(".mrow").forEach(function (row, i) {
    row.querySelector("input[type=text]").addEventListener("input", function (ev) {
      state.editRows[i].name = ev.target.value;
    });
  });
}

function addMemberRow() {
  if (state.editRows.length >= MAX_MEMBERS) { toast("最多支持 " + MAX_MEMBERS + " 人"); return; }
  state.editRows.push({ orig: "", name: "成员" + (state.editRows.length + 1) });
  renderMemberRows();
  var inputs = document.getElementById("memberRows").querySelectorAll("input[type=text]");
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function delMemberRow(i) {
  if (state.editRows.length <= MIN_MEMBERS) { toast("至少要保留 " + MIN_MEMBERS + " 人"); return; }
  var row = state.editRows[i];
  var name = (row.name || row.orig || "").trim();
  var hasHistory = state.expenses.some(function (e) {
    return e.payer === name || (e.participants || []).some(function (p) { return p.name === name; });
  });
  if (hasHistory && row.orig && !confirm("“" + name + "”已经有历史账目和分摊记录。\n删除后他会显示为“已退出”，历史账目保留，未结清的钱仍要还。\n确定删除吗？")) return;
  state.editRows.splice(i, 1);
  renderMemberRows();
}

function saveMembers() {
  var rows = state.editRows || [];
  var names = [], seen = {};
  for (var i = 0; i < rows.length; i++) {
    var nm = String(rows[i].name || "").trim();
    if (!nm) { toast("第 " + (i + 1) + " 行的名字不能为空"); return; }
    if (seen[nm]) { toast("名字重复了：" + nm); return; }
    seen[nm] = 1; names.push(nm);
  }
  if (names.length < MIN_MEMBERS) { toast("至少要 " + MIN_MEMBERS + " 人"); return; }
  if (names.length > MAX_MEMBERS) { toast("最多 " + MAX_MEMBERS + " 人"); return; }

  var picked = document.querySelector('input[name=mePick]:checked');
  var pickedIdx = picked ? parseInt(picked.value, 10) : 0;
  var oldPeople = knownPeople();
  var renamed = [], renamedOld = [], added = [];

  rows.forEach(function (r) {
    var nm = String(r.name || "").trim();
    if (r.orig && r.orig !== nm) { renameMember(r.orig, nm); renamed.push(r.orig + " → " + nm); renamedOld.push(r.orig); }
    else if (!r.orig) added.push(nm);
  });
  state.members = names.slice();
  var removed = oldPeople.filter(function (p) {
    return state.members.indexOf(p) < 0 && renamedOld.indexOf(p) < 0;
  });

  var pickedName = rows[pickedIdx] ? String(rows[pickedIdx].name || "").trim() : "";
  if (pickedName && state.members.indexOf(pickedName) >= 0) state.me = pickedName;
  else if (state.members.indexOf(state.me) < 0) state.me = state.members[0];

  state.draft = null;
  document.getElementById("parseCard").style.display = "none";
  save(); closeMembers(); renderAll();

  var msg = "成员已更新：" + state.members.length + " 人 · 记账人 " + state.me;
  if (renamed.length) msg += "；改名 " + renamed.join("、") + "（历史记录已同步）";
  if (added.length) msg += "；新增 " + added.join("、");
  if (removed.length) msg += "；" + removed.join("、") + " 的历史账目保留为“已退出”";
  toast(msg);
}

/* ---------------- 事件与交互 ---------------- */
function go(tab) {
  ["home", "book", "receipt", "list", "remind"].forEach(function (v) {
    document.getElementById("view-" + v).classList.toggle("on", v === tab);
  });
  document.querySelectorAll(".nav button").forEach(function (b) { b.classList.toggle("on", b.dataset.go === tab); });
  document.getElementById("content").scrollTop = 0;
}

document.addEventListener("click", function (ev) {
  var t = ev.target.closest("[data-go],[data-settle],[data-del],[data-clr],[data-tog],[data-mode],[data-filter],[data-chip],[data-delrow],[data-ruse]");
  if (!t) return;
  var d = t.dataset;

  if (d.delrow !== undefined) { delMemberRow(parseInt(d.delrow, 10)); return; }
  if (d.go) { go(d.go); return; }

  if (d.ruse) {
    var li = parseInt(d.ruse, 10), dl = state.rdraft && state.rdraft.lines[li];
    if (dl) { dl.use = !dl.use; renderReceiptResult(); }
    return;
  }

  if (d.settle) {
    var pr = d.settle.split("|"), from = pr[0], to = pr.slice(1).join("|");
    if (!from || !to) return;
    settlePair(state.expenses, from, to);
    save(); renderAll(); toast(from + " 与 " + to + " 之间的账已结清");
    return;
  }
  if (d.clr) {
    var e1 = state.expenses.filter(function (x) { return x.id === d.clr; })[0];
    if (e1) {
      e1.settled = {};
      knownPeople([e1]).forEach(function (m) { e1.settled[m] = true; });
      save(); renderAll(); toast("该笔已结清");
    }
    return;
  }
  if (d.del) {
    var e2 = state.expenses.filter(function (x) { return x.id === d.del; })[0];
    if (e2 && confirm("撤销这笔记账？\n" + e2.item + " " + fmt(e2.amount) + "（" + e2.payer + " 垫付）")) {
      state.expenses = state.expenses.filter(function (x) { return x.id !== d.del; });
      save(); renderAll(); toast("已撤销，钱不会算错");
    }
    return;
  }
  if (d.tog) {
    var k = d.tog.split("|"), eid = k[0], who = k.slice(1).join("|");
    var e3 = state.expenses.filter(function (x) { return x.id === eid; })[0];
    if (e3 && who) {
      e3.settled = e3.settled || {};
      e3.settled[who] = !e3.settled[who];
      save(); renderAll(); toast(who + (e3.settled[who] ? " 已结清" : " 未结清"));
    }
    return;
  }
  if (d.mode) {
    if (!state.draft) return;
    state.draft.mode = d.mode;
    document.querySelectorAll("[data-mode]").forEach(function (b) { b.classList.toggle("on", b.dataset.mode === d.mode); });
    document.getElementById("fDays").style.display = d.mode === "days" ? "grid" : "none";
    syncJson();
    return;
  }
  if (d.filter) {
    state.filter = d.filter;
    document.querySelectorAll("[data-filter]").forEach(function (b) { b.classList.toggle("on", b.dataset.filter === d.filter); });
    renderList(currentExpenses());
    return;
  }
  if (d.chip) { document.getElementById("nlInput").value = d.chip; document.getElementById("nlInput").focus(); return; }
});

/* 小票：参与人勾选 / 行内编辑 / 垫付人 */
document.getElementById("rParts").addEventListener("click", function (ev) {
  var p = ev.target.closest("[data-rpart]"); if (!p || !state.rparts) return;
  var m = p.dataset.rpart, idx = state.rparts.indexOf(m);
  if (idx >= 0) { if (state.rparts.length === 1) { toast("至少留一个人参与"); return; } state.rparts.splice(idx, 1); }
  else state.rparts.push(m);
  renderReceiptResult();
});
document.getElementById("rPayer").addEventListener("change", function (e) {
  state.rpayer = e.target.value;
  if (state.rparts.indexOf(state.rpayer) < 0) state.rparts.push(state.rpayer);
  renderReceiptResult();
});
document.getElementById("rLines").addEventListener("input", function (ev) {
  var el = ev.target;
  var i = el.dataset.rname !== undefined ? el.dataset.rname : el.dataset.ramt;
  if (i === undefined || !state.rdraft) return;
  var line = state.rdraft.lines[parseInt(i, 10)];
  if (!line) return;
  if (el.dataset.rname !== undefined) line.name = el.value;
  else {
    line.amount = num(parseFloat(el.value) || 0);
    state.rdraft.sum = num(state.rdraft.lines.reduce(function (s, l) { return s + l.amount; }, 0));
    document.getElementById("rSum").textContent = fmt(state.rdraft.sum);
    syncReceiptJson();
  }
});
function syncReceiptJson() {
  var d = state.rdraft; if (!d) return;
  var picked = d.lines.filter(function (l) { return l.use; });
  document.getElementById("rJson").textContent = "// OCR 原始文字\n" + (d.raw || "（无）") +
    "\n\n// 解析结果（确认后才入账）\n" + JSON.stringify({
      merchant: d.merchant, date: d.date, receiptTotal: num(d.total), detailSum: num(d.sum),
      confidence: d.confidence,
      lines: picked.map(function (l) { return { name: l.name, qty: l.qty, amount: num(l.amount) }; }),
      payer: state.rpayer, participants: state.rparts.slice(), source: "receipt", warnings: d.warnings
    }, null, 2);
}

/* 记账：参与人 / 垫付人 / 天数 */
document.getElementById("fParts").addEventListener("click", function (ev) {
  var p = ev.target.closest(".p"); if (!p || !state.draft) return;
  var name = p.dataset.name, idx = state.draft.parts.indexOf(name);
  if (idx >= 0) { if (state.draft.parts.length === 1) { toast("至少留一个人参与"); return; } state.draft.parts.splice(idx, 1); }
  else state.draft.parts.push(name);
  drawParts(); syncJson();
});
document.getElementById("fPayer").addEventListener("change", function (e) {
  if (!state.draft) return;
  state.draft.payer = e.target.value;
  if (state.draft.parts.indexOf(state.draft.payer) < 0) state.draft.parts.push(state.draft.payer);
  drawParts(); syncJson();
});
document.getElementById("fDays").addEventListener("input", function () { syncJson(); });

function drawParts() {
  if (!state.draft) return;
  var d = state.draft;
  var pool = state.members.slice();
  d.parts.forEach(function (n) { if (pool.indexOf(n) < 0) pool.push(n); });
  document.getElementById("fParts").innerHTML = pool.map(function (m) {
    var on = d.parts.indexOf(m) >= 0;
    return '<div class="p' + (on ? " on" : "") + '" data-name="' + esc(m) + '"><span>' + (on ? "✓" : "＋") + "</span>" + esc(m) + "</div>";
  }).join("");
  var days = d.days || {};
  document.getElementById("fDays").innerHTML = d.parts.map(function (m) {
    return '<div class="d"><span>' + esc(m) + '</span><input type="number" min="1" max="31" data-days="' + esc(m) + '" value="' + (days[m] || 30) + '" /></div>';
  }).join("");
}

function syncJson() {
  var d = state.draft; if (!d) return;
  var amount = parseFloat(document.getElementById("fAmount").value) || 0;
  var item = document.getElementById("fItem").value || d.item;
  var cat = document.getElementById("fCategory").value;
  var parts = d.parts.map(function (m) {
    var w = 1;
    var inp = document.querySelector('[data-days="' + m.replace(/"/g, '\\"') + '"]');
    if (d.mode === "days" && inp) w = Math.max(1, parseInt(inp.value, 10) || 1);
    return { name: m, weight: w };
  });
  var shares = computeShares(amount, parts);
  var payload = {
    amount: num(amount), item: item, category: cat, payer: d.payer, splitMode: d.mode,
    participants: shares.map(function (s) { return { name: s.name, weight: s.weight, share: s.share }; }),
    settled: "全部未结清", confidence: d.confidence, warnings: d.warnings, raw: d.raw, source: "nl"
  };
  document.getElementById("jsonOut").textContent = "// AI 抽取结果（写入台账前需你确认）\n" + JSON.stringify(payload, null, 2);
  document.getElementById("confLabel").textContent = "置信度 " + Math.round(d.confidence * 100) + "%" +
    (shares.some(function (s) { return s.tail; }) ? " · 已处理尾差" : "");
}

/* 按钮接线 */
document.getElementById("btnParse").addEventListener("click", function () {
  var text = document.getElementById("nlInput").value;
  if (!text.trim()) { toast("先说一句，比如“今天买水 12.4 四个人分”"); return; }
  var r = parseExpense(text);
  if (!r.ok) toast(r.warnings[0] || "没听懂，换个说法试试");
  state.draft = r;
  document.getElementById("parseCard").style.display = "block";
  document.getElementById("fAmount").value = r.amount || "";
  document.getElementById("fItem").value = r.item;
  document.getElementById("fCategory").value = r.category;
  document.getElementById("fPayer").innerHTML = state.members.map(function (m) {
    return '<option' + (m === r.payer ? " selected" : "") + ">" + esc(m) + "</option>";
  }).join("");
  document.querySelectorAll("[data-mode]").forEach(function (b) { b.classList.toggle("on", b.dataset.mode === r.mode); });
  document.getElementById("fDays").style.display = r.mode === "days" ? "grid" : "none";
  document.getElementById("parseWarn").innerHTML = r.warnings.length
    ? r.warnings.map(function (w) { return '<div class="alert" style="margin-bottom:8px"><div>🤖</div><div class="t">' + esc(w) + "</div></div>"; }).join("")
    : '<div class="alert ok"><div>✅</div><div class="t">识别成功，核对无误后确认入账。</div></div>';
  drawParts(); syncJson();
  document.getElementById("parseCard").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("btnCancel").addEventListener("click", function () {
  state.draft = null;
  document.getElementById("parseCard").style.display = "none";
  toast("已放弃这笔，台账没变");
});

document.getElementById("btnConfirm").addEventListener("click", function () {
  var d = state.draft; if (!d) { toast("先解析一句话"); return; }
  var amount = parseFloat(document.getElementById("fAmount").value) || 0;
  if (!(amount > 0)) { toast("金额要大于 0"); return; }
  var parts = d.parts.map(function (m) {
    var w = 1, inp = document.querySelector('[data-days="' + m.replace(/"/g, '\\"') + '"]');
    if (d.mode === "days" && inp) w = Math.max(1, parseInt(inp.value, 10) || 1);
    return { name: m, weight: w };
  });
  var settled = {}; parts.forEach(function (p) { settled[p.name] = p.name === d.payer; });
  var rec = {
    id: uid(), date: todayStr(), item: document.getElementById("fItem").value || d.item,
    category: document.getElementById("fCategory").value, amount: num(amount),
    payer: document.getElementById("fPayer").value, mode: d.mode, participants: parts,
    settled: settled, raw: d.raw, source: "nl"
  };
  rec.shares = computeShares(rec.amount, rec.participants);
  state.expenses.unshift(rec);
  save(); renderAll();
  state.draft = null;
  document.getElementById("parseCard").style.display = "none";
  document.getElementById("nlInput").value = "";
  toast("已入账：" + rec.item + " " + fmt(rec.amount) + " · " + rec.shares.length + " 人分摊");
  go("list");
});

document.getElementById("btnRecognize").addEventListener("click", recognizeReceipt);
document.getElementById("btnReceiptMerge").addEventListener("click", function () { receiptConfirm("merge"); });
document.getElementById("btnReceiptEach").addEventListener("click", function () { receiptConfirm("each"); });
document.getElementById("btnReceiptCancel").addEventListener("click", function () {
  state.rdraft = null;
  document.getElementById("receiptCard").style.display = "none";
  resetReceiptInput();
  toast("已放弃这张小票，台账没变");
});
document.getElementById("receiptFile").addEventListener("change", function (ev) {
  var f = ev.target.files && ev.target.files[0];
  if (!f) { resetReceiptInput(); return; }
  state.uploadFile = f;
  document.getElementById("fileName").textContent = f.name + "（" + Math.round(f.size / 1024) + " KB）" +
    (aiConfigured() ? " · 点识别交给 AI 读图" : " · 未配置 AI，可把票面文字粘到下面");
  var reader = new FileReader();
  reader.onload = function () {
    state.uploadDataUri = String(reader.result || "");
    document.getElementById("uploadPreview").innerHTML =
      '<div class="scanwrap"><img src="' + state.uploadDataUri + '" alt="上传的小票" /></div>' +
      '<div class="muted" style="margin-top:6px">本机预览，未上传任何服务器' +
      (aiConfigured() ? "；点“识别”会把这张图发给你配置的 AI 接口" : "") + "</div>";
  };
  reader.readAsDataURL(f);
});

function syncTonePicker() {
  var sel = document.getElementById("rTone");
  if (!sel) return;
  var opts = document.querySelectorAll("#tonePicker [data-tone]");
  for (var i = 0; i < opts.length; i++) {
    var on = opts[i].dataset.tone === sel.value;
    opts[i].classList.toggle("on", on);
    opts[i].setAttribute("aria-checked", on ? "true" : "false");
  }
}
document.getElementById("tonePicker").addEventListener("click", function (ev) {
  var b = ev.target.closest("[data-tone]");
  if (!b) return;
  document.getElementById("rTone").value = b.dataset.tone;
  syncTonePicker();
});

function closeWhoMenu(focusBack) {
  var btn = document.getElementById("whoTrigger");
  var menu = document.getElementById("whoMenu");
  if (!btn || !menu || menu.hidden) return;
  menu.hidden = true;
  btn.setAttribute("aria-expanded", "false");
  if (focusBack !== false) btn.focus();
}
function syncWhoPicker() {
  var sel = document.getElementById("rWho");
  var btn = document.getElementById("whoTrigger");
  var main = document.getElementById("whoMain");
  var sub = document.getElementById("whoSub");
  var av = document.getElementById("whoAvatar");
  var menu = document.getElementById("whoMenu");
  if (!sel || !btn || !main || !sub || !av || !menu) return;
  if (!sel.value) {
    btn.disabled = true;
    av.textContent = "—";
    main.textContent = "当前没有待结清";
    sub.textContent = "不用催，先享受清静";
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    menu.innerHTML = '<div class="who-empty">当前没有待结清</div>';
    return;
  }
  btn.disabled = false;
  var k = sel.value.split("|"), from = k[0], to = k.slice(1).join("|");
  var opt = sel.options[sel.selectedIndex];
  var m = opt ? String(opt.textContent).match(/¥([\d,.]+)\s*$/) : null;
  av.textContent = (from || "?").slice(0, 1);
  main.textContent = from + " → " + to;
  sub.textContent = "待结清" + (m ? " ¥" + m[1] : "");
  menu.innerHTML = Array.prototype.map.call(sel.options, function (o) {
    if (!o.value) return "";
    var p = o.value.split("|"), f = p[0], t = p.slice(1).join("|");
    var mm = String(o.textContent).match(/¥([\d,.]+)\s*$/);
    var amt = mm ? "¥" + mm[1] : "";
    var on = o.value === sel.value;
    return '<button type="button" class="who-option' + (on ? " on" : "") + '" role="option" aria-selected="' + (on ? "true" : "false") + '" data-who="' + esc(o.value) + '">' +
      '<span class="who-avatar">' + esc((f || "?").slice(0, 1)) + '</span>' +
      '<span class="who-name">' + esc(f) + ' <span class="who-arrow">→</span> ' + esc(t) + '</span>' +
      '<span class="who-amount">' + esc(amt) + '</span>' +
      (on ? '<span class="who-check">✓</span>' : "") +
      '</button>';
  }).join("");
}
document.getElementById("whoTrigger").addEventListener("click", function (ev) {
  ev.stopPropagation();
  var menu = document.getElementById("whoMenu");
  if (!menu || this.disabled) return;
  var open = menu.hidden;
  menu.hidden = !open;
  this.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    var first = menu.querySelector(".who-option");
    if (first) first.focus();
  } else {
    this.focus();
  }
});
document.getElementById("whoMenu").addEventListener("click", function (ev) {
  var b = ev.target.closest("[data-who]");
  if (!b) return;
  document.getElementById("rWho").value = b.dataset.who;
  syncWhoPicker();
  closeWhoMenu();
});
document.addEventListener("click", function (ev) {
  if (!ev.target.closest("#whoPicker")) closeWhoMenu(false);
});
document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") closeWhoMenu();
});

document.getElementById("btnRemind").addEventListener("click", function () {
  var sel = document.getElementById("rWho");
  if (!sel.value) { toast("当前没有待结清，不用催"); return; }
  var k = sel.value.split("|"), from = k[0], to = k.slice(1).join("|");
  var open = unsettled(currentExpenses()).filter(function (o) { return o.from === from && o.to === to; })[0];
  if (!open) { toast("这组已经结清了"); return; }
  var tone = document.getElementById("rTone").value;
  var text = makeReminder(open.from, open.to, open.amount, open.items, tone, open.offset || 0);
  document.getElementById("remindOut").innerHTML =
    '<div class="quote" id="remindText">' + esc(text) + "</div>" +
    '<div class="rowbtns" style="margin-top:10px"><button class="btn sm" id="btnCopy">复制这段话</button>' +
    '<button class="btn sm ghost" id="btnRemindAgain">换一个说法</button></div>' +
    '<div class="muted" style="margin-top:8px">正式版由大模型按你们的关系与历史生成；demo 用模板+变量演示同一接口。</div>';
  document.getElementById("btnCopy").addEventListener("click", function () {
    var txt = document.getElementById("remindText").textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast("已复制，去群里粘贴吧"); }, function () { toast("复制失败，可手动选中"); });
    } else {
      var ta = document.createElement("textarea");
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("复制失败，可手动选中"); }
      document.body.removeChild(ta);
    }
  });
  document.getElementById("btnRemindAgain").addEventListener("click", function () {
    var tones = ["soft", "fun", "direct"];
    document.getElementById("rTone").value = tones[(tones.indexOf(document.getElementById("rTone").value) + 1) % 3];
    syncTonePicker();
    document.getElementById("btnRemind").click();
  });
});

/* AI 面板 */
document.getElementById("btnAiSave").addEventListener("click", function () {
  aiCfg.preset = document.getElementById("aiPreset").value;
  aiCfg.base = document.getElementById("aiBase").value.trim();
  aiCfg.model = document.getElementById("aiModel").value.trim();
  aiCfg.key = document.getElementById("aiKey").value.trim();
  saveAiCfg(); renderAiState(); toast(aiConfigured() ? ("AI 已配置：" + aiCfg.model) : "接口和模型不能为空");
});
document.getElementById("btnAiClear").addEventListener("click", function () {
  aiCfg = { preset: "deepseek", base: AI_PRESETS.deepseek.base, model: AI_PRESETS.deepseek.model, key: "" };
  saveAiCfg(); renderAiState(); toast("已清除 AI 配置（本机不留 Key）");
});
document.getElementById("aiPreset").addEventListener("change", function (e) {
  var p = AI_PRESETS[e.target.value];
  if (!p) return;
  document.getElementById("aiBase").value = p.base;
  document.getElementById("aiModel").value = p.model;
});
document.getElementById("presetTrigger").addEventListener("click", function (ev) {
  ev.stopPropagation();
  var menu = document.getElementById("presetMenu");
  if (!menu) return;
  var open = menu.hidden;
  menu.hidden = !open;
  this.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    var first = menu.querySelector(".preset-option");
    if (first) first.focus();
  } else {
    this.focus();
  }
});
document.getElementById("presetMenu").addEventListener("click", function (ev) {
  var b = ev.target.closest("[data-preset]");
  if (!b) return;
  var sel = document.getElementById("aiPreset");
  sel.value = b.dataset.preset;
  sel.dispatchEvent(new Event("change"));
  syncAiPresetPicker();
  closePresetMenu();
});
document.addEventListener("click", function (ev) {
  if (!ev.target.closest("#presetPicker")) closePresetMenu(false);
});
document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") closePresetMenu();
});
document.getElementById("aiBox").addEventListener("toggle", function () {
  if (!this.open) closePresetMenu(false);
});

document.getElementById("btnHero").addEventListener("click", function () { applyHero(!state.heroCompact); });
document.getElementById("btnMembers").addEventListener("click", openMembers);
document.getElementById("btnCloseMembers").addEventListener("click", closeMembers);
document.getElementById("btnAddMember").addEventListener("click", addMemberRow);
document.getElementById("btnSaveMembers").addEventListener("click", saveMembers);
document.getElementById("memberMask").addEventListener("click", function (ev) {
  if (ev.target === document.getElementById("memberMask")) closeMembers();
});

document.getElementById("btnSeed").addEventListener("click", function () {
  state.expenses = seed().map(function (e) { e.shares = computeShares(e.amount, e.participants); return e; });
  save(); renderAll(); toast("已按当前 " + state.members.length + " 名成员生成演示数据");
});
document.getElementById("btnReset").addEventListener("click", function () {
  if (!confirm("清空所有记录？（成员设置保留，演示数据可随时重新载入）")) return;
  state.expenses = []; save(); renderAll(); toast("已清空，去“记账”写第一笔");
});

/* ---------------- 启动 ---------------- */
loadAiCfg();
state.expenses = load() || seed().map(function (e) { e.shares = computeShares(e.amount, e.participants); return e; });
renderAll();
renderAiState();
applyHero(heroIsCompact());
syncTonePicker();