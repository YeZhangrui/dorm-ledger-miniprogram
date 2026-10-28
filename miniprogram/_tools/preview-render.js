/**
 * 静态预览渲染器：把 WXML + WXSS 转成网页，用真实设备尺寸截图，方便在没有开发者工具时审设计。
 *
 * 用法（在 D:\小组作业 下）：
 *   node miniprogram\_tools\preview-render.js            渲染全部页面
 *   node miniprogram\_tools\preview-render.js list       只渲染某一页
 * 产物：miniprogram\_preview\<page>.html（再用 Edge headless 截图成 png）
 *
 * 说明：只做"看设计"用的近似渲染，不替代真机；wx:* 指令按 mock 数据求值。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_preview');
const PHONE_W = Number(process.argv[4]) || 375;
const PHONE_H = Number(process.argv[3]) || 812;

const PAGES = {
  index: { wxml: 'pages/index/index.wxml', wxss: 'pages/index/index.wxss', custom: true, tab: 0 },
  book: { wxml: 'pages/book/book.wxml', wxss: 'pages/book/book.wxss', tab: 1 },
  receipt: { wxml: 'pages/receipt/receipt.wxml', wxss: 'pages/receipt/receipt.wxss', tab: 2 },
  list: { wxml: 'pages/list/list.wxml', wxss: 'pages/list/list.wxss', tab: 3 },
  remind: { wxml: 'pages/remind/remind.wxml', wxss: 'pages/remind/remind.wxss', tab: 4 },
  members: { wxml: 'pages/members/members.wxml', wxss: 'pages/members/members.wxss' },
  room: { wxml: 'pages/room/room.wxml', wxss: 'pages/room/room.wxss' },
  onboarding: { wxml: 'pages/onboarding/onboarding.wxml', wxss: 'pages/onboarding/onboarding.wxss' },
  about: { wxml: 'pages/about/about.wxml', wxss: 'pages/about/about.wxss' }
};

const TABS = ['首页', '记账', '小票', '明细', '提醒'];
const TAB_ICONS = ['home', 'book', 'receipt', 'list', 'remind'];
const TAB_COLOR = '#55625b';
const TAB_ON = '#116e56';

// 自定义组件：预览时把组件的 WXML 内联渲染（小程序里是真实组件实例）
const COMPONENTS = {
  'sheet-select': 'components/sheet-select/index.wxml'
};
const COMPONENT_WXSS = ['components/sheet-select/index.wxss'];

/* ---------- 颜色/尺寸：wxss → css ---------- */
function toCss(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return '';
  let css = fs.readFileSync(file, 'utf8');
  css = css.replace(/(-?\d*\.?\d+)rpx/g, (m, n) => parseFloat(n) / 2 + 'px');
  css = css.replace(/(^|[\s,}])page(?=\s*[{,])/g, '$1body');
  css = css.replace(/^page\s*\{/m, 'body{');
  return css;
}

/* ---------- WXML 解析 ---------- */
const VOID_TAGS = { input: 1, image: 1, switch: 1, slider: 1, textarea: 1, radio: 1, progress: 1, icon: 1 };

function parseWxml(src) {
  src = src.replace(/<!--[\s\S]*?-->/g, '');
  let i = 0;
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) pushText(src.slice(i, lt));
    const gt = findTagEnd(src, lt);
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([A-Za-z0-9-]+)/.exec(body);
    if (!m) continue;
    const node = { tag: m[1].toLowerCase(), attrs: parseAttrs(body.slice(m[0].length)), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID_TAGS[node.tag]) stack.push(node);
  }
  return root;

  function pushText(t) {
    if (!t.trim()) return;
    stack[stack.length - 1].children.push({ tag: '#text', text: t });
  }
}

function findTagEnd(src, start) {
  let q = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '>') return i;
  }
  return src.length;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([A-Za-z0-9_:.-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
  let m;
  while ((m = re.exec(s))) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : 'true');
  }
  return attrs;
}

/* ---------- 表达式求值 ---------- */
function scopeProxy(obj) {
  return new Proxy(obj, {
    has() { return true; },
    get(t, k) {
      if (k === Symbol.unscopables) return undefined;
      return t[k];
    },
    set() { return true; }
  });
}

function evalExpr(expr, data) {
  try {
    const fn = new Function('scope', 'with(scope){return (' + expr + ')}');
    const v = fn(scopeProxy(data));
    return v === undefined || v === null ? '' : v;
  } catch (e) {
    return '';
  }
}

function interp(str, data) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{([\s\S]*?)\}\}/g, (m, expr) => {
    const v = evalExpr(expr.trim(), data);
    return v === '' ? '' : String(v);
  });
}

/* ---------- 渲染 ---------- */
// 保留 WXML 的标签名（view/text/image…），这样 wxss 里的元素选择器（.seg view 等）也能命中；
// 再用 BASE_CSS 给这些自定义标签补上浏览器默认没有的 display。
const TAG_MAP = {
  'scroll-view': 'scroll-view', 'swiper': 'swiper', 'swiper-item': 'swiper-item',
  'navigator': 'navigator', 'form': 'form', 'label': 'label', 'button': 'button',
  'textarea': 'textarea', 'input': 'input', 'block': null
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- 自定义组件（预览时内联渲染） ---------- */
const compAstCache = {};
function getComponentAst(tag) {
  if (!compAstCache[tag]) {
    compAstCache[tag] = parseWxml(fs.readFileSync(path.join(ROOT, COMPONENTS[tag]), 'utf8'));
  }
  return compAstCache[tag];
}

function renderComponent(node, data) {
  const a = node.attrs || {};
  const exprOf = (key) => (a[key] === undefined ? null : String(a[key]));
  const val = (key, dflt) => {
    const raw = exprOf(key);
    if (raw === null) return dflt;
    // 不带 {{}} 的属性是字面量（如 title="找谁催"），不要当表达式求值
    if (raw.indexOf('{{') < 0) return raw;
    const v = evalExpr(raw.replace(/^\{\{|\}\}$/g, ''), data);
    return v === '' || v === undefined ? dflt : v;
  };
  const props = {
    title: val('title', '请选择'),
    placeholder: val('placeholder', '请选择'),
    empty: val('empty', '暂无可选项'),
    sub: val('sub', ''),
    disabled: !!val('disabled', false),
    options: val('options', []) || [],
    index: Number(val('index', 0)) || 0
  };
  const rows = (props.options || []).map((o, i) =>
    (o && typeof o === 'object') ? Object.assign({ id: 'o' + i }, o) : { id: 'o' + i, label: String(o) });
  const scope = Object.assign({}, props, {
    rows: rows,
    cur: rows[props.index] || null,
    open: process.env.SHEET === '1'
  });
  return renderChildren(getComponentAst(node.tag).children, scope);
}

function renderChildren(children, data) {  let out = '';
  let emittedIf = null; // true/false 表示上一个 wx:if 链是否命中
  for (const node of children) {
    if (node.tag === '#text') {
      out += esc(interp(node.text, data)).replace(/\n\s*/g, '\n');
      continue;
    }
    const a = node.attrs;
    if (a['wx:if'] !== undefined) {
      emittedIf = !!evalExpr(a['wx:if'].replace(/^\{\{|\}\}$/g, ''), data);
      if (!emittedIf) continue;
      out += renderNode(node, data, true);
      continue;
    }
    if (a['wx:elif'] !== undefined) {
      if (emittedIf) continue;
      emittedIf = !!evalExpr(a['wx:elif'].replace(/^\{\{|\}\}$/g, ''), data);
      if (!emittedIf) continue;
      out += renderNode(node, data, true);
      continue;
    }
    if (a['wx:else'] !== undefined) {
      if (emittedIf) continue;
      emittedIf = true;
      out += renderNode(node, data, true);
      continue;
    }
    emittedIf = null;
    out += renderNode(node, data, false);
  }
  return out;
}

function renderNode(node, data, skipDirective) {
  const a = node.attrs || {};
  if (COMPONENTS[node.tag]) return renderComponent(node, data);
  if (!skipDirective && a['wx:for'] !== undefined) {
    const listExpr = a['wx:for'].replace(/^\{\{|\}\}$/g, '');
    const list = evalExpr(listExpr, data);
    if (!Array.isArray(list)) return '';
    const itemName = a['wx:for-item'] || 'item';
    const idxName = a['wx:for-index'] || 'index';
    return list.map((item, idx) => {
      const child = Object.assign({}, data);
      child[itemName] = item;
      child[idxName] = idx;
      const clone = Object.assign({}, node, { attrs: Object.assign({}, a) });
      delete clone.attrs['wx:for'];
      return renderNode(clone, child, true);
    }).join('');
  }
  if (node.tag === 'block') return renderChildren(node.children, data);

  const htmlTag = TAG_MAP[node.tag] === undefined ? node.tag : TAG_MAP[node.tag];
  if (htmlTag === null) return renderChildren(node.children, data);

  const cls = a.class ? interp(a.class, data) : '';
  const style = a.style ? interp(a.style, data) : '';
  let attrs = '';
  if (a.id) attrs += ' id="' + esc(interp(a.id, data)) + '"';
  if (cls) attrs += ' class="' + esc(cls) + '"';
  if (style) attrs += ' style="' + esc(style) + '"';
  if (node.tag === 'image') {
    const src = a.src ? interp(a.src, data) : '';
    return `<img${attrs} src="${esc(src)}" alt="">`;
  }
  if (node.tag === 'input' || node.tag === 'textarea') {
    const v = a.value ? interp(a.value, data) : '';
    if (node.tag === 'textarea') {
      attrs += ' placeholder="' + esc(a.placeholder ? interp(a.placeholder, data) : '') + '"';
      return `<textarea${attrs}>${esc(v)}</textarea>`;
    }
    if (node.tag === 'input') {
      if (a.password !== undefined) attrs += ' type="password"';
      attrs += ' value="' + esc(v) + '" placeholder="' + esc(a.placeholder ? interp(a.placeholder, data) : '') + '"';
      return `<input${attrs}>`;
    }
  }
  if (node.tag === 'radio') return `<span class="sim-radio"></span>`;
  if (node.tag === 'switch') {
    const on = evalExpr(String(a.checked || '').replace(/^\{\{|\}\}$/g, ''), data);
    return `<span class="sim-switch ${on ? 'on' : ''}"></span>`;
  }
  if (node.tag === 'img') return `<${htmlTag}${attrs}>`;
  return `<${htmlTag}${attrs}>${renderChildren(node.children, data)}</${htmlTag}>`;
}

/* ---------- mock 数据 ---------- */
const MEMBERS = ['陈默', '李昊', '王雨', '赵小满'];
const PARTS = MEMBERS.map((m, i) => ({ name: m, on: i < 4, days: 30 }));

const MOCKS = {
  index: {
    nav: { statusBarHeight: 54, navBarHeight: 43, capsuleReserve: 102 },
    compact: process.env.COMPACT === '1',
    dormText: '4 人寝室 · 公共开支台账',
    statusText: '当前记账人：陈默',
    roomText: 'A7K2M9',
    heroTotal: '¥355.20',
    heroSub: '人均 ¥88.80 · 6 笔 · 4 人',
    heroMini: '本月 ¥355.20',
    showAlert: true,
    alertTotal: '45.75',
    alertItems: 5,
    unsettledCountText: '4 组待结清（已抵消）',
    hasOpen: true,
    people: [
      { name: '陈默', ex: false, cls: 'pos', txt: '+¥117.60' },
      { name: '李昊', ex: false, cls: 'neg', txt: '-¥45.00' },
      { name: '王雨', ex: false, cls: 'neg', txt: '-¥43.80' },
      { name: '赵小满', ex: true, cls: 'neg', txt: '-¥28.80' }
    ],
    settle: [
      { key: 'a', from: '李昊', to: '陈默', amountText: '¥19.80', detail: '网费 ¥30.00 · 电费 ¥21.60 · 洗洁精、洗衣液 ¥1.80', offsetText: '已自动对冲反向欠款 ¥1.80，实收 ¥19.80' },
      { key: 'b', from: '赵小满', to: '陈默', amountText: '¥45.00', detail: '网费 ¥30.00 · 微波炉维修 ¥15.00', offsetText: '' },
      { key: 'c', from: '王雨', to: '陈默', amountText: '¥9.15', detail: '桶装水、垃圾袋 ¥9.15', offsetText: '' }
    ],
    recent: [
      { key: '1', icon: '⚡', item: '电费', tags: [{ text: '1 人未结', cls: 'no' }], meta: '2026-10-05 · 陈默 垫付 · 4 人 · 人均 ¥21.60', amountText: '¥86.40', tail: false },
      { key: '2', icon: '🧻', item: '桶装水、垃圾袋', tags: [{ text: '已结清', cls: 'ok' }, { text: '🧾 小票', cls: 'rc' }], meta: '2026-10-03 · 李昊 垫付 · 4 人 · 人均 ¥9.15', amountText: '¥36.60', tail: true },
      { key: '3', icon: '📶', item: '网费', tags: [{ text: '已结清', cls: 'ok' }], meta: '2026-10-01 · 陈默 垫付 · 4 人 · 人均 ¥30.00', amountText: '¥120.00', tail: false }
    ]
  },
  list: {
    filter: 'all',
    emptyText: '',
    records: [
      {
        id: 'e1', icon: '⚡', item: '电费', date: '2026-10-05',
        raw: '电费 86 块 4，平摊', isReceipt: false, receiptText: '',
        amountText: '¥86.40', payer: '陈默',
        chips: [
          { name: '陈默', text: '陈默 ¥21.60 ✓', cls: 'ok' },
          { name: '李昊', text: '李昊 ¥21.60 未结', cls: 'no' },
          { name: '王雨', text: '王雨 ¥21.60 ✓', cls: 'ok' },
          { name: '赵小满', text: '赵小满 ¥21.60 ✓', cls: 'ok' }
        ]
      },
      {
        id: 'e2', icon: '🧾', item: '好邻居便利店（3 项）', date: '2026-10-14',
        raw: '小票识别：好邻居便利店 桶装水 12.40 / 垃圾袋 8.90', isReceipt: true, receiptText: '（好邻居便利店）',
        amountText: '¥21.30', payer: '李昊',
        chips: [
          { name: '李昊', text: '李昊 ¥5.33 ✓', cls: 'ok' },
          { name: '陈默', text: '陈默 ¥5.32 未结', cls: 'no' },
          { name: '王雨', text: '王雨 ¥5.33 未结', cls: 'no' },
          { name: '赵小满', text: '赵小满（已退出）￥5.32 ✓', cls: 'ok' }
        ]
      }
    ]
  },
  book: {
    me: '陈默',
    memberNames: MEMBERS,
    input: '今天买水 12.4 四个人分',
    samples: ['今天买水 12.4 四个人分', '我垫了网费 120，全寝室 AA', '电费 86 块 4，平摊'],
    draft: { ok: true },
    warnings: ['没有识别到垫付人，默认记在你名下'],
    categories: ['水电', '网费', '日用品', '食品', '维修', '其他'],
    catOptions: ['水电', '网费', '日用品', '食品', '维修', '其他'].map(function (c) { return { label: c }; }),
    payerOptions: MEMBERS.map(function (m) { return { label: m }; }),
    catIndex: 2,
    payerIndex: 0,
    amount: '12.40',
    item: '桶装水',
    parts: PARTS,
    mode: 'equal',
    jsonText: '{\n  "amount": 12.4,\n  "item": "桶装水",\n  "category": "日用品",\n  "payer": "陈默",\n  "splitMode": "equal",\n  "participants": [ ... ]\n}',
    confText: '置信度 82% · 已处理尾差',
    foldOpen: false
  },
  receipt: {
    aiOpen: process.env.AIOPEN === '1',
    aiState: '当前：deepseek-flash @ https://api.deepseek.com（已填 Key）',
    presetLabels: ['DeepSeek', 'OpenAI 兼容'],
    presetOptions: ['DeepSeek', 'OpenAI 兼容'].map(function (l) { return { label: l }; }),
    presetIndex: 0,
    aiBase: 'https://api.deepseek.com',
    aiModel: 'deepseek-flash',
    aiKey: 'sk-xxxx',
    aiJsonMode: true,
    imagePath: '',
    text: '',
    draft: { ok: true },
    merchant: '好邻居便利店',
    dateText: '2026-10-14',
    sumText: '¥21.30',
    totalText: '¥21.30',
    provider: 'DeepSeek 识图',
    warnings: [],
    lines: [
      { id: 0, name: '桶装水', amountText: '12.40', use: true, low: false },
      { id: 1, name: '垃圾袋', amountText: '8.90', use: true, low: true },
      { id: 2, name: '购物袋', amountText: '0.00', use: false, low: false }
    ],
    rawText: '好邻居便利店\n日期：2026-10-14\n桶装水 12.40\n垃圾袋 8.90\n合计 21.30',
    memberNames: MEMBERS,
    payerOptions: MEMBERS.map(function (m) { return { label: m }; }),
    payerIndex: 1,
    parts: PARTS,
    foldOpen: false
  },
  remind: {
    hasOpen: true,
    whoIndex: 1,
    whoOptions: [
      { label: '陈默 → 李昊', desc: '网费 ¥30.00 · 电费 ¥21.60（已对冲 ¥1.80）', side: '¥19.80' },
      { label: '陈默 → 赵小满', desc: '网费 ¥30.00（已对冲 ¥1.80）', side: '¥15.00' },
      { label: '王雨 → 李昊', desc: '桶装水、垃圾袋 ¥9.15', side: '¥9.15' }
    ],
    tones: [
      { key: 'soft', name: '委婉', desc: '金额小 / 关系好' },
      { key: 'fun', name: '幽默', desc: '熟 / 起哄用' },
      { key: 'direct', name: '直接', desc: '金额大 / 催过几次' }
    ],
    toneIndex: 1,
    remindText: '李昊 ~ 这个月寝室的网费和电费我先垫啦，你这边还差 19.80。不急不急，哪天顺手转我就行～',
    report: {
      total: '¥355.20', per: '¥88.80', count: 6, ratio: 62,
      cats: [
        { cat: '网费', icon: '📶', amountText: '¥150.00', pct: 42, w: 42 },
        { cat: '电费', icon: '⚡', amountText: '¥86.40', pct: 24, w: 24 },
        { cat: '日用品', icon: '🧻', amountText: '¥58.80', pct: 17, w: 17 },
        { cat: '维修', icon: '🛠', amountText: '¥60.00', pct: 17, w: 17 }
      ],
      text: '【10 月寝室账目月报】\n本月公共开支 ¥355.20，共 6 笔，人均 ¥88.80。\n已结清 62%，还有 4 组待结清。'
    }
  },
  members: {
    rows: MEMBERS.map((m, i) => ({ id: 'm' + i, name: m })),
    meIndex: 0
  },
  room: {
    code: 'A7K2M9',
    label: '4 人 · 陈默的账本',
    count: 6,
    totalText: '¥355.20',
    joinText: '',
    rooms: [
      { code: 'A7K2M9', label: '4 人 · 陈默的账本', count: 6, totalText: '¥355.20', on: true },
      { code: 'C3H8TQ', label: '4 人 · 2025 秋', count: 3, totalText: '¥128.40', on: false }
    ],
    importing: false,
    importText: '',
    importDraft: null,
    importInfo: ''
  },
  onboarding: {
    cloudReady: true,
    name: '陈默',
    avatarUrl: '',
    roomName: '',
    joinCode: '',
    busy: '',
    hasLocal: true,
    localText: '本机这本账有 6 笔记录、4 位成员，可以一键搬到云端（只搬一次）。'
  },
  about: {
    version: '2.0.0',
    contact: '点击下方按钮可直接联系开发者'
  }
};

/* ---------- 组装 HTML ---------- */
function buildHtml(page, data) {
  const cfg = PAGES[page];
  const wxml = parseWxml(fs.readFileSync(path.join(ROOT, cfg.wxml), 'utf8'));
  const css = toCss('app.wxss') + '\n' +
    COMPONENT_WXSS.map(toCss).join('\n') + '\n' + toCss(cfg.wxss);
  const body = renderChildren(wxml.children, data);

  const withNav = !cfg.custom;
  const navHtml = withNav
    ? `<div class="sim-nav">
         <div class="sim-status"><span>16:41</span><span>▮▮▮ ⌁</span></div>
         <div class="sim-nav-row"><span class="sim-nav-title">寝室公共开支台账</span></div>
         <span class="sim-capsule">···⊙</span>
       </div>`
    : `<div class="sim-status sim-status-dark"><span>16:41</span><span>▮▮▮ ⌁</span><span class="sim-capsule">···⊙</span></div>`;

  const tabHtml = cfg.tab !== undefined
    ? `<div class="sim-tabbar">${TABS.map((t, i) =>
        `<div class="sim-tab ${i === cfg.tab ? 'on' : ''}">
           <img src="${pathToFile(path.join(ROOT, 'assets/tabbar', TAB_ICONS[i] + (i === cfg.tab ? '-on' : '') + '.png'))}">
           <span>${t}</span>
         </div>`).join('')}</div>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#dfddd6}
  /* WXML 自定义标签在浏览器里没有默认 display，这里补上（小程序里由框架提供） */
  view,scroll-view,picker,block,form,label,swiper,swiper-item,navigator{display:block}
  text{display:inline}
  image{display:inline-block}
  .phone{width:${PHONE_W}px;height:${PHONE_H}px;overflow:hidden;position:relative;background:var(--paper)}
  .phone .scroller{height:100%;overflow:auto}
  ${css}
  /* ---- 模拟微信外壳（不参与小程序样式） ---- */
  .sim-status{position:relative;height:54px;display:flex;align-items:flex-end;
    justify-content:space-between;padding:0 22px 6px;box-sizing:border-box;color:#fff;
    font:600 12px/1 -apple-system,"Microsoft YaHei";pointer-events:none}
  .sim-status-dark{position:absolute;left:0;right:0;top:0;z-index:95}
  .sim-nav{position:absolute;left:0;right:0;top:0;height:98px;background:#0d3b2d;
    display:flex;flex-direction:column;z-index:89;box-sizing:border-box}
  .sim-nav-row{height:44px;display:flex;align-items:center;justify-content:center}
  .sim-nav-title{color:#fff;font:500 17px/1 -apple-system,"Microsoft YaHei";letter-spacing:.01em}
  .sim-capsule{position:absolute;right:7px;top:59px;width:87px;height:32px;border-radius:16px;
    border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.14);color:#fff;
    display:grid;place-items:center;font-size:14px;letter-spacing:6px}
  .sim-status-dark .sim-capsule{top:5px}
  .sim-tabbar{position:absolute;left:0;right:0;bottom:0;height:56px;background:#fffefb;
    border-top:1px solid rgba(0,0,0,.12);display:flex;z-index:90;
    padding-bottom:env(safe-area-inset-bottom,0)}
  .sim-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
    color:${TAB_COLOR};font:10px/1.2 -apple-system,"Microsoft YaHei"}
  .sim-tab img{width:26px;height:26px}
  .sim-tab.on{color:${TAB_ON}}
  /* 预览专用：真实设备上 position:fixed 相对屏幕视口；网页里会被撑到浏览器视口，
     把弹层"缩"回手机框内，否则截图里会看到面板溢出手机边框 */
  .phone .ss-mask{position:absolute}
  .phone .who-mask{position:absolute}
  /* 真机上 tabBar 在 WebView 之外，页面视口不含它；预览里把它扣掉，弹层才不会被压住 */
  .phone.with-tab .ss-mask{bottom:56px}
  .sim-radio{display:inline-block;width:22px;height:22px;border:1px solid #d2ccbd;border-radius:50%}
  .sim-switch{display:inline-block;width:52px;height:32px;border-radius:16px;background:${TAB_ON}}
  .phone.with-nav .scroller{padding-top:98px}
  .phone.with-tab .scroller{padding-bottom:56px}
</style></head>
<body>
  <div class="phone ${withNav ? 'with-nav' : ''} ${cfg.tab !== undefined ? 'with-tab' : ''}">
    <div class="scroller">${body}</div>
    ${navHtml}
    ${tabHtml}
  </div>
</body></html>`;
}

function pathToFile(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

/* ---------- main ---------- */
const only = process.argv[2];
const targets = only ? [only] : Object.keys(PAGES);
fs.mkdirSync(OUT, { recursive: true });
for (const page of targets) {
  if (!PAGES[page]) { console.error('unknown page:', page); continue; }
  const html = buildHtml(page, MOCKS[page] || {});
  const file = path.join(OUT, page + '.html');
  fs.writeFileSync(file, html, 'utf8');
  console.log('rendered', file);
}
