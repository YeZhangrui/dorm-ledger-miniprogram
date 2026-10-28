/**
 * 寝室公共开支台账 · 纯逻辑层（不依赖 wx，可在 node 里直接单测）
 * 分摊（含尾差）/ 结算（两两抵消）/ 一句话解析 / 小票解析 / 催缴话术 / 月报
 */
const DEFAULT_MEMBERS = ['陈默', '李昊', '王雨', '赵小满'];
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 8;

const ALIAS = { 老王: '王雨', 小雨: '王雨', 昊子: '李昊', 默默: '陈默', 小满: '赵小满', 老李: '李昊' };
const NICK = { 陈默: '默默', 李昊: '昊子', 王雨: '小雨', 赵小满: '小满' };
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_WORD = { 2: '两', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八' };
const CATEGORY_ICON = { 饮用水: '💧', 电费: '⚡', 网费: '🌐', 日用品: '🧻', 食品: '🍪', 维修: '🔧', 其他: '🧾' };
const CATEGORIES = ['饮用水', '电费', '网费', '日用品', '食品', '维修', '其他'];
const CAT_RULES = [
  { cat: '饮用水', re: /(桶装水|矿泉水|饮水|买水|水)/ },
  { cat: '电费', re: /(电费|空调|热水器|电)/ },
  { cat: '网费', re: /(网费|宽带|路由器|wifi|无线网)/i },
  { cat: '日用品', re: /(纸巾|卫生纸|抽纸|纸|垃圾袋|洗洁精|洗衣液|洁厕灵|牙膏|日用品|水桶)/ },
  { cat: '食品', re: /(零食|水果|橙子|苹果|香蕉|小吃|菜|外卖|吃|饮料)/ },
  { cat: '维修', re: /(维修|修|换新|上门费)/ }
];

/* ---------------- 基础工具 ---------------- */
function num(n) {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  // 金额统一两位小数：先收敛浮点尾巴再四舍五入（9.155 → 9.16，355.2 → 355.2）
  return Math.round(Number((v * 100).toFixed(6))) / 100;
}
function fmt(n) {
  return '¥' + num(n).toFixed(2);
}
function plain(n) {
  return num(n).toFixed(2);
}
function pad2(x) {
  return String(x).padStart(2, '0');
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function monthKey() {
  return todayStr().slice(0, 7);
}
function cnWord(n) {
  return CN_WORD[n] || String(n);
}
function moneySpeech(n) {
  const v = num(n);
  const yuan = Math.floor(v);
  const rest = Math.round((v - yuan) * 100);
  const jiao = Math.floor(rest / 10);
  const fen = rest % 10;
  let s = yuan + ' 块';
  if (jiao) s += ' ' + jiao + ' 毛';
  if (fen) s += ' ' + fen;
  return s;
}
function nick(name) {
  return NICK[name] || name;
}
function categoryIcon(cat) {
  return CATEGORY_ICON[cat] || '🧾';
}
function guessCategory(text) {
  const s = String(text || '');
  for (let i = 0; i < CAT_RULES.length; i++) {
    if (CAT_RULES[i].re.test(s)) return CAT_RULES[i].cat;
  }
  return '其他';
}

/* ---------------- 分摊（含尾差） ---------------- */
/**
 * parts: [{name, weight}] → [{name, weight, share, tail}]，合计严格等于 amount
 *
 * 算法：**最大余数法**（整数「分」运算 + 余数按小数部分从大到小分配）。
 * 早先是「每人先四舍五入，最后一人吃尾差」，在极小金额下会把最后一人算成负数
 * （0.05 元 / 7 人 → 前 6 人各 0.01，最后一人 −0.01），余额表里会出现“倒欠 1 分”。
 * 现在保证：每份 ≥ 0、合计严格等于总额、只有真正被补了分的人且最多 n−1 份带 tail。
 */
function computeShares(amount, parts) {
  if (!parts || !parts.length) return [];
  const totalCents = Math.round(num(amount) * 100); // 用「分」做整数运算，避开浮点误差
  const sign = totalCents < 0 ? -1 : 1;
  const absCents = Math.abs(totalCents);
  const n = parts.length;

  const weights = parts.map(function (p) {
    return Number(p.weight) > 0 ? Number(p.weight) : 1;
  });
  const sumW = weights.reduce(function (s, w) { return s + w; }, 0);

  // 1) 先按权重取整到分（向下），并记下小数余数
  const base = [];
  const frac = [];
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const exact = (absCents * weights[i]) / sumW;
    const floor = Math.floor(exact + 1e-6); // +epsilon 防 4999.9999999 被判成 4999
    base.push(floor);
    frac.push(exact - floor);
    allocated += floor;
  }

  // 2) 剩下的几分钱，按小数余数从大到小依次补 1 分；
  //    余数相同的按「后面的先补」，保持"最后一人吃尾差"的既有观感，且结果稳定（不依赖排序稳定性）
  const order = frac
    .map(function (f, i) { return { i: i, f: f }; })
    .sort(function (a, b) { return b.f - a.f || b.i - a.i; });
  const tail = new Array(n);
  for (let i = 0; i < n; i++) tail[i] = false;
  let left = absCents - allocated;
  for (let k = 0; left > 0; k++) {
    const idx = order[k % n].i;
    base[idx] += 1;
    tail[idx] = true;
    left -= 1;
  }

  return parts.map(function (p, i) {
    return {
      name: p.name,
      weight: weights[i],
      share: num((sign * base[i]) / 100),
      tail: tail[i]
    };
  });
}

/** 记录缺 shares 时补齐 */
function ensureShares(expenses) {
  return (expenses || []).map(function (e) {
    if (e.shares && e.shares.length) return e;
    const copy = Object.assign({}, e);
    copy.shares = computeShares(e.amount, e.participants);
    return copy;
  });
}

function knownPeople(members, expenses) {
  const set = (members || []).slice();
  (expenses || []).forEach(function (e) {
    if (set.indexOf(e.payer) < 0) set.push(e.payer);
    (e.participants || []).forEach(function (p) {
      if (set.indexOf(p.name) < 0) set.push(p.name);
    });
  });
  return set;
}
function isExMember(members, name) {
  return (members || []).indexOf(name) < 0;
}

/** 每人的 已垫付 / 应承担 / 净差额（含已退出成员） */
function balances(expenses, members) {
  const list = ensureShares(expenses);
  const people = knownPeople(members, list);
  const map = {};
  people.forEach(function (m) { map[m] = { name: m, paid: 0, owed: 0, ex: isExMember(members, m) }; });
  list.forEach(function (e) {
    if (map[e.payer]) map[e.payer].paid = num(map[e.payer].paid + num(e.amount));
    e.shares.forEach(function (p) {
      if (!map[p.name]) map[p.name] = { name: p.name, paid: 0, owed: 0, ex: true };
      map[p.name].owed = num(map[p.name].owed + p.share);
    });
  });
  return people.map(function (m) {
    return { name: m, paid: map[m].paid, owed: map[m].owed, net: num(map[m].paid - map[m].owed), ex: map[m].ex };
  });
}

/** 待结清：按“谁 → 谁”汇总，再把 A→B 与 B→A 两两抵消 */
function unsettled(expenses) {
  const list = ensureShares(expenses);
  const dirs = {};
  list.forEach(function (e) {
    e.shares.forEach(function (p) {
      if (p.name === e.payer) return;
      if (e.settled && e.settled[p.name]) return;
      const key = p.name + '>' + e.payer;
      if (!dirs[key]) dirs[key] = { from: p.name, to: e.payer, amount: 0, items: [] };
      dirs[key].amount = num(dirs[key].amount + p.share);
      dirs[key].items.push({ id: e.id, item: e.item, amount: p.share, date: e.date });
    });
  });
  const out = [];
  const seen = {};
  Object.keys(dirs).forEach(function (k) {
    if (seen[k]) return;
    seen[k] = true;
    const d = dirs[k];
    const revKey = d.to + '>' + d.from;
    const rev = dirs[revKey];
    if (!rev) {
      out.push({ from: d.from, to: d.to, amount: d.amount, offset: 0, items: d.items });
      return;
    }
    seen[revKey] = true;
    const net = num(d.amount - rev.amount);
    if (net > 0) {
      out.push({ from: d.from, to: d.to, amount: net, offset: rev.amount, items: d.items, offsetItems: rev.items });
    } else if (net < 0) {
      out.push({ from: rev.from, to: rev.to, amount: num(-net), offset: d.amount, items: rev.items, offsetItems: d.items });
    }
  });
  return out.sort(function (a, b) { return b.amount - a.amount; });
}

/** 按笔展开的未结清（做徽标、逐笔核对用） */
function unsettledItems(expenses) {
  const out = [];
  ensureShares(expenses).forEach(function (e) {
    e.shares.forEach(function (p) {
      if (p.name === e.payer) return;
      if (e.settled && e.settled[p.name]) return;
      out.push({ expenseId: e.id, debtor: p.name, creditor: e.payer, share: p.share, item: e.item, date: e.date });
    });
  });
  return out;
}

/** 两人之间（双向）一次性结清，返回新数组 */
function settlePair(expenses, a, b) {
  return ensureShares(expenses).map(function (e) {
    const copy = Object.assign({}, e);
    const shares = computeShares(e.amount, e.participants);
    copy.shares = shares;
    copy.settled = Object.assign({}, e.settled || {});
    shares.forEach(function (p) {
      if (p.name === e.payer) return;
      if ((p.name === a && e.payer === b) || (p.name === b && e.payer === a)) {
        copy.settled[p.name] = true;
      }
    });
    return copy;
  });
}

/** 改名：同步成员列表 / 当前记账人 / 所有历史记录（返回新的三元组） */
function renameMember(state, oldName, newName) {
  const members = (state.members || []).map(function (m) { return m === oldName ? newName : m; });
  const me = state.me === oldName ? newName : state.me;
  const expenses = (state.expenses || []).map(function (e) {
    const copy = Object.assign({}, e);
    if (copy.payer === oldName) copy.payer = newName;
    copy.participants = (e.participants || []).map(function (p) {
      return p.name === oldName ? Object.assign({}, p, { name: newName }) : p;
    });
    if (copy.settled && Object.prototype.hasOwnProperty.call(copy.settled, oldName)) {
      copy.settled = Object.assign({}, copy.settled);
      copy.settled[newName] = copy.settled[oldName];
      delete copy.settled[oldName];
    }
    copy.shares = null; // 让下游重算
    return copy;
  });
  return { members: members, me: me, expenses: expenses };
}

/* ---------------- 演示数据 ---------------- */
function seed(members) {
  const M = members || DEFAULT_MEMBERS;
  const N = M.length;
  const mk = monthKey();
  const pick = function (i) { return M[((i % N) + N) % N]; };
  const plan = [
    { d: '01', item: '网费', cat: '网费', amount: 120.0, payer: 0, open: [] },
    { d: '03', item: '桶装水、垃圾袋', cat: '日用品', amount: 36.6, payer: 1, open: [2] },
    { d: '05', item: '电费', cat: '电费', amount: 86.4, payer: 0, open: [1] },
    { d: '06', item: '公共零食', cat: '食品', amount: 45.0, payer: 2, open: [] },
    { d: '08', item: '微波炉维修', cat: '维修', amount: 60.0, payer: 3, open: [0] },
    { d: '09', item: '洗洁精、洗衣液', cat: '日用品', amount: 7.2, payer: 1, open: [0, 3] }
  ];
  return plan.map(function (p, idx) {
    const payer = pick(p.payer);
    const settled = {};
    M.forEach(function (m) { settled[m] = true; });
    p.open.forEach(function (i) {
      const nm = pick(i);
      if (nm !== payer) settled[nm] = false;
    });
    const participants = M.map(function (m) { return { name: m }; });
    return {
      id: 'e' + (idx + 1),
      date: mk + '-' + p.d,
      item: p.item,
      category: p.cat,
      amount: p.amount,
      payer: payer,
      mode: 'equal',
      participants: participants,
      settled: settled,
      source: 'nl',
      raw: '（演示数据）' + p.item + ' ' + p.amount + ' 元，' + cnWord(N) + '个人分',
      shares: computeShares(p.amount, participants)
    };
  });
}

/* ---------------- 一句话记账 ---------------- */
function parseExpense(text, members, me) {
  const M = members || DEFAULT_MEMBERS;
  const N = M.length;
  const meName = me || M[0];
  const raw = String(text || '').trim();
  const res = {
    ok: false, raw: raw, amount: 0, item: '', category: '其他', payer: meName,
    parts: M.slice(), mode: 'equal', confidence: 0.5, warnings: []
  };
  if (!raw) { res.warnings.push('还没输入内容'); return res; }

  let t = raw.replace(/\s+/g, '');
  let signals = 0;

  /* 先摘掉日期与“N 个人/N 天” */
  t = t.replace(/(\d{1,2})月(\d{1,2})?日?/g, '');
  let declaredCount = 0;
  t = t.replace(/([一两二三四五六七八九]|\d+)(个?人|位|名|天)/g, function (_all, cnt) {
    const v = CN_NUM[cnt] || parseInt(cnt, 10) || 0;
    if (v && v <= 8 && !declaredCount) declaredCount = v;
    return '';
  });
  if (/我们仨|仨人/.test(t)) { declaredCount = declaredCount || 3; t = t.replace(/我们仨|仨人/g, ''); }

  /* 金额 */
  let amount = null;
  let m;
  if ((m = t.match(/(\d+)\s*(?:块|元)\s*([0-9])(?!\d)/))) {
    amount = parseFloat(m[1] + '.' + m[2]);
  } else if ((m = t.match(/(\d+(?:\.\d{1,2})?)\s*(?:块|元|块钱)/))) {
    amount = parseFloat(m[1]);
  } else {
    const dec = t.match(/\d+\.\d{1,2}/);
    if (dec) {
      amount = parseFloat(dec[0]);
    } else {
      const allNum = t.match(/\d+/g) || [];
      if (allNum.length) amount = Math.max.apply(null, allNum.map(Number));
    }
  }
  if (amount != null && isFinite(amount) && amount > 0) {
    res.amount = num(amount);
    signals++;
  } else {
    res.warnings.push('没听出金额，补一句“多少钱”就行');
  }

  /* 项目与类别 */
  res.category = guessCategory(raw);
  let itemLabel = '';
  const itemMatch = raw.match(/(?:买|垫了|付了|交了|花了|充了|维修|修)([^0-9，,。.、]{1,10})/);
  if (itemMatch && itemMatch[1]) {
    itemLabel = itemMatch[1].replace(/([一两二三四五六七八九])?个?人|我们|全寝室|平摊|均摊|分|AA/g, '').trim();
  }
  if (!itemLabel) itemLabel = res.category === '其他' ? '' : res.category;
  res.item = itemLabel || '公共开支';
  if (itemLabel && itemLabel.length <= 2 && res.category !== '其他') res.item = res.category;
  if (itemLabel) signals++;

  /* 垫付人 */
  const payersFound = [];
  Object.keys(ALIAS).forEach(function (a) {
    if (raw.indexOf(a) >= 0 && M.indexOf(ALIAS[a]) >= 0) payersFound.push(ALIAS[a]);
  });
  M.forEach(function (m2) { if (raw.indexOf(m2) >= 0) payersFound.push(m2); });
  const hasPayVerb = /(垫|先付|付了|买|出了|我出)/.test(raw);
  if (payersFound.length && hasPayVerb && /(垫|先付|付了|出)/.test(raw)) {
    res.payer = payersFound[0];
    signals++;
    if (res.payer !== meName) res.warnings.push('垫付人识别为 ' + res.payer + '，请核对');
  } else {
    res.payer = meName;
  }

  /* 参与人 */
  let parts = M.slice();
  const exclMe = /除了\s*(我|自己)|不含我|不算我/.test(raw);
  const pairMatch = raw.match(/我和([\u4e00-\u9fa5]{2,4})(?:分|平摊|均摊|AA)/);
  if (exclMe) {
    parts = M.filter(function (m3) { return m3 !== meName; });
    signals++;
    res.warnings.push('识别为“除我之外”，已排除 ' + meName);
  } else if (pairMatch) {
    const who = pairMatch[1];
    const whoName = (ALIAS[who] && M.indexOf(ALIAS[who]) >= 0) ? ALIAS[who] : (M.indexOf(who) >= 0 ? who : null);
    if (whoName) {
      parts = [meName, whoName];
      signals++;
    } else {
      res.warnings.push('“' + who + '”不在成员名单里，请手动勾选参与人');
    }
  } else if (declaredCount && declaredCount !== N) {
    parts = M.slice();
    res.warnings.push('句子里说 ' + declaredCount + ' 人，寝室是 ' + N + ' 人，已先按全部成员分摊，请核对参与人');
  } else if (declaredCount === N || /全寝室|全寝|所有人|平摊|均摊|AA/.test(raw)) {
    parts = M.slice();
    signals++;
  }
  if (parts.indexOf(res.payer) < 0 && parts.length && !exclMe) {
    res.warnings.push('垫付人 ' + res.payer + ' 不在参与人里，请核对是否不用他分摊');
  }
  res.parts = parts;

  /* 分摊方式 */
  if (/按天|居住天数|住了几天/.test(raw)) {
    res.mode = 'days';
    res.warnings.push('按居住天数分摊，请填写每人天数');
  }
  if (/我请|不用还|请客/.test(raw)) res.warnings.push('检测到“请客”语气，本笔仍按分摊入账，可手动改为不分摊');

  res.confidence = Math.min(0.98, 0.55 + signals * 0.11);
  res.ok = res.amount > 0 && parts.length >= 1;
  return res;
}

/* ---------------- 小票：文字 → 明细行 ---------------- */
function finishReceipt(out) {
  if (!out.merchant) out.merchant = '未识别商家';
  if (!out.date) {
    out.date = todayStr();
    out.warnings.push('没识别到日期，已按今天 ' + out.date);
  }
  out.sum = num(out.lines.reduce(function (s, l) { return s + l.amount; }, 0));
  const distinct = (out.totals || []).filter(function (v, i, a) { return a.indexOf(v) === i; });
  out.total = distinct.length ? distinct[0] : out.sum;
  if (distinct.length > 1) {
    out.warnings.push('票面出现多个不同的总额（' + distinct.map(fmt).join(' / ') + '），已取 ' + fmt(out.total) + '，请核对是不是两单并排或有折扣');
  } else if (!distinct.length && out.lines.length) {
    out.warnings.push('票面没识别到“合计/实收”行，已按明细加总 ' + fmt(out.sum));
  }
  if (out.lines.length && Math.abs(out.sum - out.total) > 0.01) {
    out.warnings.push('明细合计 ' + fmt(out.sum) + ' 与票面总额 ' + fmt(out.total) + ' 相差 ' +
      fmt(Math.abs(out.sum - out.total)) + '：可能有漏识别、折扣或抹零，请逐行核对');
  }
  if (!out.lines.length) out.warnings.push('没解析出明细行：请确认每行是“品名 金额”的格式，也可以手动补录');
  if (!out.confidence) out.confidence = out.lines.length ? 0.8 : 0.35;
  return out;
}

function parseReceiptText(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  const out = { merchant: '', date: '', total: 0, sum: 0, totals: [], lines: [], warnings: [], confidence: 0.5, raw: raw, provider: '手动粘贴的票面文字' };
  if (!lines.length) {
    out.warnings.push('没有可识别的文字，请粘贴票面内容');
    return out;
  }
  const DATE_RE = /(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/;
  const TOTAL_RE = /(合计|总计|实收|应付|应收|金额)/;
  const TOTAL_BAD = /(优惠|折扣|减免|找零|积分|支付)/;
  const HEADER_RE = /^(商品名|品名|名称|数量|单价|小计|总额|金额|备注|项目)$/;
  const NOISE_RE = /(存到相册|找相似图|找高清图|问这张图|查看原网页|有图有真相|购物小票|\d+\s*px|^更多$|^小票)/i;
  const SKIP_RE = /(合计|总计|实付|应付|应收|找零|收银|单号|流水|账单|机号|桌号|人数|件数|会员|扫码|微信|支付宝|支付|发票|税|谢谢|欢迎|电话|地址|门店|时间|服务员|数量|单价|小计|总额|原价|现价|优惠|折扣|减免)/;

  let pendingName = '';
  lines.forEach(function (ln) {
    if (/^\d{1,2}\s*\/\s*\d{1,2}$/.test(ln) || NOISE_RE.test(ln) || /^1\d{10}$/.test(ln)) {
      pendingName = '';
      return;
    }
    const dm = ln.match(DATE_RE);
    if (dm && !out.date) out.date = dm[1] + '-' + pad2(dm[2]) + '-' + pad2(dm[3]);

    const am = ln.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*(?:元)?\s*$/);
    const trailing = am ? am[1] : '';

    if (TOTAL_RE.test(ln) && !TOTAL_BAD.test(ln)) {
      const tv = parseFloat(trailing);
      if (tv > 0) out.totals.push(num(tv));
      return;
    }
    if (SKIP_RE.test(ln) || HEADER_RE.test(ln)) {
      pendingName = '';
      return;
    }
    if (!am || trailing.indexOf('.') < 0) {
      const cleanTxt = ln.replace(/^[【\[]+|[】\]]+$/g, '').trim();
      if (/^[+\-=_\s]+$/.test(cleanTxt)) return;
      if (!out.merchant && !/\d/.test(cleanTxt) && cleanTxt.length >= 2) {
        out.merchant = cleanTxt;
        pendingName = '';
        return;
      }
      if (!/\d/.test(cleanTxt) && cleanTxt.length >= 2 && cleanTxt.length <= 14) pendingName = cleanTxt;
      return;
    }
    const amount = parseFloat(trailing);
    if (!(amount > 0)) return;
    let head = ln.slice(0, ln.length - am[0].length).trim()
      .replace(/^[x×*]\s*\d+\s*/i, '')
      .replace(/[x×*]\s*\d+\s*$/gi, '');
    let prev;
    do {
      prev = head;
      head = head.replace(/(?:^|\s)\d+(?:\.\d+)?\s*$/g, '').trim();
    } while (head !== prev);

    const digitsOnly = /^[\d.\s]*$/.test(head);
    if (digitsOnly && !pendingName) return;
    let name = digitsOnly ? pendingName : (head || pendingName || '');
    pendingName = '';
    if (!name) name = '未识别项目';
    out.lines.push({
      name: name,
      amount: num(amount),
      conf: num(name === '未识别项目' ? 0.45 : 0.62 + (name.length >= 2 ? 0.2 : 0) + 0.13)
    });
  });

  out.merchant = out.merchant || lines[0];
  out.confidence = out.lines.length
    ? num(out.lines.reduce(function (s, l) { return s + Math.max(0.3, l.conf); }, 0) / out.lines.length)
    : 0.35;
  return finishReceipt(out);
}

/* ---------------- AI 识图：回复解析与归一化 ---------------- */
const AI_PROMPT = '你是寝室公共开支记账助手。请识别这张小票图片，只输出一个 JSON 对象，不要解释、不要 markdown 代码块：\n' +
  '{"merchant":"商家名","date":"YYYY-MM-DD","total":票面总额,"lines":[{"name":"商品名","qty":1,"amount":金额}]}\n' +
  '要求：1) 金额一律为数字，不带货币符号；2) date 取票面日期，识别不到填空字符串；' +
  '3) lines 只放真正购买的商品或服务，不要包含合计、找零、支付方式、会员、页眉页脚，也不要包含截图里的按钮文字（如“存到相册”“找相似图”）。';

const AI_PRESETS = {
  deepseek: { label: 'DeepSeek（deepseek-flash，支持图片）', base: 'https://api.deepseek.com', model: 'deepseek-flash' },
  dashscope: { label: '通义千问（阿里云 DashScope）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max-latest' },
  zhipu: { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-plus' },
  volc: { label: '火山方舟（豆包）', base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1.5-vision-pro' },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
};
const AI_PRESET_KEYS = Object.keys(AI_PRESETS);

function extractJsonFromText(text) {
  const s = String(text || '').replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function normalizeAiReceipt(obj, provider, rawText) {
  const out = {
    merchant: '', date: '', total: 0, sum: 0, totals: [], lines: [], warnings: [],
    confidence: 0.9, raw: rawText || '', provider: provider || 'AI 识图'
  };
  if (!obj) {
    out.warnings.push('模型没返回可解析的 JSON，请重试，或改用粘贴票面文字');
    return finishReceipt(out);
  }
  out.merchant = String(obj.merchant || '').trim();
  const d = String(obj.date || '').trim();
  const dm = d.match(/(\d{4})\D{1,2}(\d{1,2})\D{1,2}(\d{1,2})/);
  if (dm) {
    // 日期合理性：只接受「去年 1 月 1 日 ~ 明天」。小票 OCR 偶尔会认出 2017 这种离谱年份，
    // 一旦落库就会跑出"本月支出"的统计口径，用户还以为总额算错了。
    const y = parseInt(dm[1], 10);
    const m = parseInt(dm[2], 10);
    const dd = parseInt(dm[3], 10);
    const iso = y + '-' + pad2(m) + '-' + pad2(dd);
    const now = new Date();
    const todayIso = todayStr();
    const test = new Date(y, m - 1, dd);
    const valid = m >= 1 && m <= 12 && dd >= 1 && dd <= 31 &&
      test.getFullYear() === y && test.getMonth() === m - 1 && test.getDate() === dd;
    const minIso = (now.getFullYear() - 1) + '-01-01';
    const tmr = new Date(now.getTime() + 24 * 3600 * 1000);
    const maxIso = tmr.getFullYear() + '-' + pad2(tmr.getMonth() + 1) + '-' + pad2(tmr.getDate());
    if (valid && iso >= minIso && iso <= maxIso) {
      out.date = iso;
    } else {
      out.date = todayIso;
      out.warnings.push('票面日期「' + iso + '」看起来不对（早于去年或晚于今天），已按今天入账，可在核对页改');
    }
  }
  const t = parseFloat(obj.total);
  if (t > 0) out.totals.push(num(t));
  (obj.lines || []).forEach(function (l) {
    const a = parseFloat(l && l.amount);
    if (!(a > 0)) return;
    const nm = String((l && l.name) || '').trim();
    out.lines.push({
      name: nm || '未识别项目',
      qty: parseFloat((l && l.qty) || 1) || 1,
      amount: num(a),
      conf: nm ? 0.92 : 0.5
    });
  });
  return finishReceipt(out);
}

/* ---------------- 催缴话术 ---------------- */
function makeReminder(debtor, creditor, amount, items, tone, offset) {
  const nn = nick(debtor);
  const cn = nick(creditor);
  const list = items || [];
  const itemTxt = list.slice(0, 2).map(function (x) { return x.item; }).join('、') + (list.length > 2 ? '等' : '');
  const n = list.length;
  const speech = moneySpeech(amount);
  const off = Number(offset) > 0 ? '（我这边欠你的 ' + fmt(offset) + ' 已经帮你扣掉了）' : '';
  if (tone === 'fun') {
    return '【寝室公共基金催缴通知】' + nn + ' 同学：\n' +
      '经查，你在「' + itemTxt + '」等 ' + n + ' 笔公共开支中还差 ' + fmt(amount) + '（' + speech + '）没到位 😂' +
      (off ? '\n（反向欠款已自动对冲，' + fmt(offset) + '，不用你算）' : '') + '\n' +
      '基金缺口已影响下批零食采购计划，' + cn + ' 同学表示理解并保持关注。\n' +
      '转账入口：点这里 →' + cn + ' 的收款码（不催不催，就是提醒一下）';
  }
  if (tone === 'direct') {
    return nn + '，' + itemTxt + '+ 共 ' + n + ' 笔公共开支你这边还有 ' + fmt(amount) + ' 没结' + off + '，方便的时候转我一下，谢谢～';
  }
  return nn + '～' + itemTxt + '那几笔加起来是 ' + fmt(amount) + '（' + speech + '）' + off + '，你要是方便的时候转我下就行，不急～';
}

/* ---------------- 月报 ---------------- */
function makeReport(expenses, members) {
  const list = ensureShares(expenses);
  const N = (members || []).length || 1;
  const mk = monthKey();
  const cur = list.filter(function (e) { return (e.date || '').slice(0, 7) === mk; });
  const use = cur.length ? cur : list;
  const total = num(use.reduce(function (s, e) { return s + num(e.amount); }, 0));
  const per = num(total / N);
  const byCat = {};
  use.forEach(function (e) { byCat[e.category] = num((byCat[e.category] || 0) + num(e.amount)); });
  const cats = Object.keys(byCat)
    .map(function (k) { return { cat: k, amount: byCat[k], pct: Math.round((byCat[k] / (total || 1)) * 100) }; })
    .sort(function (a, b) { return b.amount - a.amount; });
  const open = unsettled(use);
  const openTotal = num(open.reduce(function (s, x) { return s + x.amount; }, 0));
  const closedRatio = total ? Math.round((1 - openTotal / total) * 100) : 100;
  const lines = [];
  lines.push('本月公共开支共 ' + fmt(total) + '，' + use.length + ' 笔，' + N + ' 人人均 ' + fmt(per) + '，平均每笔 ' + fmt(use.length ? total / use.length : 0) + '。');
  if (cats.length) {
    lines.push('支出最多的类别是「' + cats[0].cat + '」，' + fmt(cats[0].amount) + '，占 ' + cats[0].pct + '%；' +
      (cats[1] ? '其次是「' + cats[1].cat + '」（' + fmt(cats[1].amount) + '）。' : ''));
  }
  lines.push('目前结清进度 ' + closedRatio + '%' + (openTotal > 0
    ? '，还有 ' + fmt(openTotal) + ' 待结清，涉及 ' + open.length + ' 个组合，建议用“催缴提醒”一键发出。'
    : '，全部结清，寝室财务健康 👍'));
  if (cats.length && cats[0].cat === '电费' && cats[0].pct > 20) {
    lines.push('提示：电费占比较高（夏季空调为主要变量），可约定空调 26℃ 与睡前定时，预计能降一成。');
  }
  lines.push('建议：饮用水与日用品属于小额高频，可约定“谁顺手谁买、买完一句话记账”，减少反复垫付。');
  return {
    total: total, per: per, count: use.length, cats: cats, open: open,
    openTotal: openTotal, closedRatio: closedRatio, text: lines.join('\n')
  };
}

module.exports = {
  DEFAULT_MEMBERS, MIN_MEMBERS, MAX_MEMBERS, ALIAS, NICK, CN_WORD, CATEGORIES,
  CATEGORY_ICON, CAT_RULES, AI_PROMPT, AI_PRESETS, AI_PRESET_KEYS,
  num, fmt, plain, pad2, todayStr, monthKey, cnWord, moneySpeech, nick,
  categoryIcon, guessCategory,
  computeShares, ensureShares, knownPeople, isExMember, balances, unsettled, unsettledItems,
  settlePair, renameMember, seed,
  parseExpense, parseReceiptText, finishReceipt,
  extractJsonFromText, normalizeAiReceipt,
  makeReminder, makeReport
};
