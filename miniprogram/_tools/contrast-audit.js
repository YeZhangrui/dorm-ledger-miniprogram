#!/usr/bin/env node
/**
 * 对比度审计脚本 —— 微信小程序「寝室公共开支台账」
 *
 * 用法（在 D:\小组作业 下）：
 *   node miniprogram\_tools\contrast-audit.js
 *
 * 做什么：
 *   1. 解析 miniprogram/app.wxss + pages/ *.wxss，取出 page{} 里的 CSS 自定义属性，
 *      支持 var(--x, fallback) 的 fallback 链；支持 rgba()/rgb()/十六进制 3/6/8 位。
 *   2. 按"组件组合表"逐条计算 WCAG 2.1 对比度。组合表不是"同一条规则里 fg/bg 都在"的
 *      机械配对，而是读 WXML/WXSS 后整理出的真实叠放关系（继承、透明度、渐变叠加）。
 *      颜色优先从 WXSS 同名选择器实时读取，读不到才用表内兜底值——所以 Lead 改色后重跑即更新。
 *   3. 判定 AA / AAA，并对未达标项反解同色相的替换色（保持色相，只调明度）。
 *   4. 输出 _audit/contrast-report.md（中文报告）与 _audit/contrast-data.json（机器可读）。
 *
 * 本脚本只读工程文件，唯一写入目标是 miniprogram/_audit/。
 * 无第三方依赖，Node >= 16。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * 0. 路径
 * ------------------------------------------------------------------ */

const MP_DIR = path.resolve(__dirname, '..'); // .../miniprogram
const AUDIT_DIR = path.join(MP_DIR, '_audit');

const REL = (p) => path.relative(MP_DIR, p).replace(/\\/g, '/');

/* ------------------------------------------------------------------ *
 * 1. 颜色：解析 / 叠加 / WCAG
 * ------------------------------------------------------------------ */

/** 解析 #rgb #rgba #rrggbb #rrggbbaa rgb() rgba() transparent */
function parseColor(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };

  if (s[0] === '#') {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const c = h.split('').map((ch) => parseInt(ch + ch, 16));
      return { r: c[0], g: c[1], b: c[2], a: h.length === 4 ? c[3] / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i) => parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }

  const m = s.match(/^rgba?\s*\(([^)]*)\)$/);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (v, scale) => (v.endsWith('%') ? (parseFloat(v) / 100) * scale : parseFloat(v));
    const r = num(parts[0], 255);
    const g = num(parts[1], 255);
    const b = num(parts[2], 255);
    let a = 1;
    if (parts.length >= 4) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if ([r, g, b, a].some((v) => Number.isNaN(v))) return null;
    return { r, g, b, a };
  }
  return null;
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function toHex(c) {
  const h = (v) => clampByte(v).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

/** top 叠在 bottom 上（bottom 必须不透明） */
function composite(top, bottom) {
  const a = top.a;
  if (a >= 1) return { r: top.r, g: top.g, b: top.b, a: 1 };
  const outA = a + bottom.a * (1 - a);
  const f = (t, b) => (t * a + b * bottom.a * (1 - a)) / (outA || 1);
  return { r: f(top.r, bottom.r), g: f(top.g, bottom.g), b: f(top.b, bottom.b), a: outA };
}

/** WCAG 2.1 相对亮度 */
function luminance(c) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function contrastRatio(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function rgbToHsl(c) {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const hue2rgb = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v, a: 1 };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    a: 1,
  };
}

/* ------------------------------------------------------------------ *
 * 2. WXSS 解析
 * ------------------------------------------------------------------ */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 顶层分隔符切分（不切 () [] 和引号里的） */
function splitTopLevel(str, sep) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (const ch of str) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function parseDecls(body) {
  const out = [];
  for (const chunk of splitTopLevel(body, ';')) {
    const t = chunk.trim();
    if (!t) continue;
    const k = t.indexOf(':');
    if (k < 0) continue;
    out.push({ prop: t.slice(0, k).trim().toLowerCase(), value: t.slice(k + 1).trim() });
  }
  return out;
}

/** 解析成 [{ selector, selectors:[], decls:[], media }] */
function parseRules(css, media, out) {
  const n = css.length;
  let i = 0;
  let selStart = 0;
  while (i < n) {
    const ch = css[i];
    if (ch === '{') {
      const selector = css.slice(selStart, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      const body = css.slice(i + 1, j - 1);
      if (/^@media/i.test(selector)) parseRules(body, selector, out);
      else if (!/^@/.test(selector)) {
        out.push({
          selector,
          selectors: splitTopLevel(selector, ',').map((s) => s.trim()).filter(Boolean),
          decls: parseDecls(body),
          media: media || null,
        });
      }
      i = j;
      selStart = i;
      continue;
    }
    if (ch === '}') {
      i++;
      selStart = i;
      continue;
    }
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. 变量解析（含 fallback 链）
 * ------------------------------------------------------------------ */

function matchParen(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function substituteVars(expr, vars, depth = 0) {
  const missing = [];
  if (depth > 20) return { value: null, missing };
  let str = String(expr).trim();
  for (;;) {
    const i = str.indexOf('var(');
    if (i < 0) break;
    const close = matchParen(str, i + 3);
    if (close < 0) return { value: null, missing };
    const parts = splitTopLevel(str.slice(i + 4, close), ',');
    const name = parts[0].trim();
    const fallback = parts.length > 1 ? parts.slice(1).join(',').trim() : null;

    let replacement = null;
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const r = substituteVars(vars[name], vars, depth + 1);
      replacement = r.value;
      missing.push(...r.missing);
    }
    if (replacement == null && fallback != null) {
      const r = substituteVars(fallback, vars, depth + 1);
      replacement = r.value;
      missing.push(...r.missing);
    }
    if (replacement == null) {
      missing.push(name);
      return { value: null, missing };
    }
    str = (str.slice(0, i) + replacement + str.slice(close + 1)).trim();
  }
  return { value: str, missing };
}

function resolveColor(expr, vars) {
  if (expr == null) return { color: null, missing: [], raw: null };
  const sub = substituteVars(expr, vars);
  if (sub.value == null) return { color: null, missing: sub.missing, raw: null };
  return { color: parseColor(sub.value), missing: sub.missing, raw: sub.value };
}

/** 从任意 CSS 值里抽出所有颜色/变量 token（用于渐变） */
function colorTokens(value) {
  return value.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|var\(--[\w-]+\)/g) || [];
}

/* ------------------------------------------------------------------ *
 * 4. 读取工程
 * ------------------------------------------------------------------ */

function walk(dir, filter, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, filter, acc);
    else if (filter(full)) acc.push(full);
  }
  return acc;
}

function loadProject() {
  const wxssFiles = [
    path.join(MP_DIR, 'app.wxss'),
    ...walk(path.join(MP_DIR, 'pages'), (p) => p.endsWith('.wxss')).sort(),
    // 自定义组件（components/**）的样式也要审
    ...walk(path.join(MP_DIR, 'components'), (p) => p.endsWith('.wxss')).sort(),
  ];
  const rules = [];
  const scanned = [];
  for (const f of wxssFiles) {
    if (!fs.existsSync(f)) continue;
    parseRules(stripComments(fs.readFileSync(f, 'utf8')), null, rules);
    scanned.push(f);
  }

  // 选择器 -> {prop: 最后一次声明}（页面 wxss 在 app.wxss 之后加载，后写覆盖前写）
  const declIndex = new Map();
  for (const r of rules) {
    if (r.media) continue; // 只用基础规则，保证可重复
    for (const sel of r.selectors) {
      let bucket = declIndex.get(sel);
      if (!bucket) {
        bucket = Object.create(null);
        declIndex.set(sel, bucket);
      }
      for (const d of r.decls) bucket[d.prop] = d.value;
    }
  }

  // page{} 里的自定义属性
  const vars = Object.create(null);
  for (const r of rules) {
    if (r.media || !r.selectors.includes('page')) continue;
    for (const d of r.decls) if (d.prop.startsWith('--')) vars[d.prop] = d.value;
  }

  let appJson = null;
  try {
    appJson = JSON.parse(fs.readFileSync(path.join(MP_DIR, 'app.json'), 'utf8'));
  } catch {
    appJson = null;
  }

  return {
    rules,
    declIndex,
    vars,
    varCount: Object.keys(vars).length,
    wxssFiles: scanned,
    wxmlFiles: walk(path.join(MP_DIR, 'pages'), (p) => p.endsWith('.wxml')).sort(),
    appJson,
  };
}

/** 某选择器在某属性上的最后声明，没有则 null */
function decl(project, selector, prop) {
  const bucket = project.declIndex.get(selector);
  if (!bucket) return null;
  return bucket[prop] != null ? bucket[prop] : null;
}

/** 按优先级逐个选择器找属性值，第一个非空命中 */
function firstDecl(project, selectors, prop) {
  if (!selectors) return null;
  for (const sel of selectors) {
    const v = decl(project, sel, prop);
    if (v != null) return { value: v, selector: sel };
  }
  return null;
}

/** "25rpx" / "13px" -> rpx 数值 */
function toRpx(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(-?[\d.]+)\s*(rpx|px)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  return /^px$/i.test(m[2]) ? n * 2 : n;
}

/* ------------------------------------------------------------------ *
 * 5. 建议色：固定色相与饱和度，只调明度
 * ------------------------------------------------------------------ */

function suggestColor(start, bg, target) {
  const { h, s, l } = rgbToHsl(start);
  const STEP = 0.002;
  const ok = (c) => contrastRatio(c, bg) >= target;

  for (let k = 1; k * STEP <= 1; k++) {
    const dl = k * STEP;
    const cands = [];
    if (l - dl >= 0) cands.push(l - dl);
    if (l + dl <= 1) cands.push(l + dl);
    for (const nl of cands) {
      const c = hslToRgb(h, s, nl);
      if (ok(c)) return { color: c, ratio: contrastRatio(c, bg) };
    }
  }
  for (let nl = 0; nl <= 1; nl += STEP) {
    const c = hslToRgb(h, s, nl);
    if (ok(c)) return { color: c, ratio: contrastRatio(c, bg) };
  }
  for (const c of [{ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }]) {
    if (ok(c)) return { color: c, ratio: contrastRatio(c, bg) };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 6. 组件组合表
 *
 * 字段：
 *   selector  选择器（展示用）
 *   where     出现在哪个页面/位置
 *   css       读样的选择器候选（具体 -> 一般）；颜色/字号/字重都按此顺序读取
 *   fg        前景兜底色（CSS 里读不到时用）
 *   bg        背景兜底：字符串 = 单一样本；[[..],[..]] = 多候选，每个候选是多层叠加
 *   size      字号兜底（rpx）
 *   weight    字重（不填则从 CSS 读）
 *   opacity   元素整体不透明度
 *   bgNote    背景说明
 *   note      组件说明
 *   source    依据
 * ------------------------------------------------------------------ */

const SCANLINE = 'rgba(255,255,255,.035)'; // .topbar::before 的白色扫描线
const GOLD_GLOW = 'rgba(217,185,121,.1)'; // .topbar 左上角径向光斑（文字所在位置的上限）
const GOLD_GLOW_HALF = 'rgba(217,185,121,.05)';

/** 深色头部：渐变起点（最亮）/ 终点（最暗），均叠 3.5% 白色扫描线 */
const HDR = [
  ['#0f3d2e', SCANLINE],
  ['#0a2b21', SCANLINE],
];
/** 深色头部 + 左上角金色光斑（.brand-kicker 所在位置） */
const HDR_GLOW = [
  ['#0f3d2e', GOLD_GLOW, SCANLINE],
  ['#0f3d2e', GOLD_GLOW_HALF, SCANLINE],
  ['#0a2b21', SCANLINE],
];
/** 深色头部 + 按钮自身半透明白底（.icon-btn 是 5.5%，.room-pill 是 7%） */
const HDR_BTN = [
  ['#0f3d2e', SCANLINE, 'rgba(255,255,255,.055)'],
  ['#0a2b21', SCANLINE, 'rgba(255,255,255,.055)'],
];
const HDR_PILL = [
  ['#0f3d2e', SCANLINE, 'rgba(255,255,255,.07)'],
  ['#0a2b21', SCANLINE, 'rgba(255,255,255,.07)'],
];

const ENTRIES = [
  /* ---------------- tabBar（读 app.json） ---------------- */
  {
    selector: 'tabBar 未选中文字',
    where: 'app.json tabBar.color / backgroundColor',
    tabBar: 'color',
    bg: 'tabBar.backgroundColor',
    size: 20,
    weight: 400,
    source: 'app.json',
    note: '系统 tabBar 渲染，字号按微信默认约 10px 估算；这里仍是旧 --ink-3 值，未跟随新变量',
  },
  {
    selector: 'tabBar 选中文字',
    where: 'app.json tabBar.selectedColor / backgroundColor',
    tabBar: 'selectedColor',
    bg: 'tabBar.backgroundColor',
    size: 20,
    weight: 400,
    source: 'app.json',
    note: '',
  },

  /* ---------------- 首页深色头部 ---------------- */
  {
    selector: '.brand-kicker',
    where: '首页头部「寝账 · Dorm Ledger」',
    css: ['.brand-kicker'],
    fg: 'var(--gold)',
    bg: HDR_GLOW,
    bgNote: '头部渐变+金色光斑',
    source: 'index.wxml L8 / app.wxss',
    note: '金色字叠在含金色光斑的深底上，是最吃紧的头部组合',
  },
  {
    selector: '.dorm',
    where: '首页头部寝室名',
    css: ['.topbar .dorm', '.dorm'],
    fg: 'var(--on-header)',
    bg: HDR,
    bgNote: '头部渐变最亮处',
    source: 'index.wxml L13 / index.wxss L54',
    note: '页面 wxss 覆盖为 34rpx / 700',
  },
  {
    selector: '.status',
    where: '首页头部状态行',
    css: ['.topbar .status', '.status'],
    fg: 'var(--on-header-2)',
    bg: HDR,
    bgNote: '头部渐变最亮处',
    source: 'index.wxml L15',
    note: '--on-header-2 是半透明白，先合成到底色再算',
  },
  {
    selector: '.hero .label',
    where: '首页头部「本月公共开支」',
    css: ['.hero .label'],
    fg: 'var(--on-header-2)',
    bg: HDR,
    bgNote: '头部渐变最亮处',
    source: 'index.wxml L21',
    note: '',
  },
  {
    selector: '.hero .amount',
    where: '首页头部金额',
    css: ['.topbar .hero .amount', '.hero .amount'],
    fg: '#fffdf6',
    bg: HDR,
    bgNote: '头部渐变最亮处',
    source: 'index.wxml L22',
    note: '首页覆盖为 84rpx',
  },
  {
    selector: '.hero .sub',
    where: '首页头部副标题',
    css: ['.hero .sub'],
    fg: 'var(--on-header-2)',
    bg: HDR,
    bgNote: '头部渐变最亮处',
    source: 'index.wxml L23',
    note: '',
  },
  {
    selector: '.icon-btn',
    where: '首页头部 成员 / 演示数据 / 清空',
    css: ['.icon-btn'],
    fg: 'var(--on-header)',
    bg: HDR_BTN,
    bgNote: '头部+按钮 7% 白底',
    source: 'index.wxml L30-L33',
    note: '',
  },
  {
    selector: '.icon-btn.danger-ghost',
    where: '首页头部「清空」',
    css: ['.icon-btn.danger-ghost', '.icon-btn'],
    fg: '#f1c9c2',
    bg: HDR_BTN,
    bgNote: '头部+按钮 7% 白底',
    source: 'index.wxml L32',
    note: '头部里唯一的粉红字',
  },
  {
    selector: '.room-pill',
    where: '首页头部房间胶囊',
    css: ['.room-pill'],
    fg: 'var(--on-header)',
    bg: HDR_PILL,
    bgNote: '头部+胶囊 7% 白底',
    source: 'index.wxml L16',
    note: '',
  },

  /* ---------------- 页面与卡片底字 ---------------- */
  {
    selector: 'page 默认正文',
    where: '页面底色上未被卡片覆盖的文字',
    css: ['page'],
    fg: 'var(--ink)',
    bg: 'var(--paper)',
    bgNote: '页面底色 --paper',
    source: 'app.wxss page{}',
    note: '全局 31rpx 字号的来源',
  },
  {
    selector: '.card 内继承正文',
    where: '各页卡片正文',
    css: ['.card'],
    fg: 'var(--ink)',
    bg: 'var(--surface)',
    size: 31,
    weight: 400,
    bgNote: '卡片面 --surface',
    source: 'app.wxss .card',
    note: '卡片本身不设 color，靠 page 继承',
  },
  {
    selector: '.card-head .h2',
    where: '卡片标题',
    css: ['.card-head .h2', '.card'],
    fg: 'var(--ink)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'index.wxml L49 等',
    note: '',
  },
  {
    selector: '.card-sub',
    where: '卡片副标题',
    css: ['.card-sub'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'index.wxml L50',
    note: '',
  },
  {
    selector: '.note',
    where: '首页「每个人的账」脚注',
    css: ['.note', '.card'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'index.wxml L59',
    note: '虚线分隔的说明文字',
  },
  {
    selector: '.muted',
    where: '明细页日期 / 原始语句 / 「天」',
    css: ['.muted', '.card'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'list.wxml L19-L22',
    note: '',
  },
  {
    selector: '.hint',
    where: '各页提示段落',
    css: ['.hint', '.card'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'book.wxml L25',
    note: '',
  },
  {
    selector: '.hint-inline',
    where: '参与人 / 明细行旁的小提示',
    css: ['.hint-inline', '.card'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'book.wxml L68',
    note: '',
  },
  {
    selector: '.lbl',
    where: '表单字段标签',
    css: ['.field > .lbl', '.lbl', '.card'],
    fg: 'var(--ink-2)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'book.wxml L12',
    note: '表单里是 .field > .lbl，字重比通用 .lbl 更高',
  },
  {
    selector: '.empty',
    where: '空状态',
    css: ['.empty'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface-2)',
    bgNote: '浅灰底 --surface-2',
    source: 'index.wxml L70',
    note: '',
  },
  {
    selector: '.rec .meta',
    where: '记录细节行',
    css: ['.rec .meta', '.card'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'index.wxml L75 / L103',
    note: '',
  },
  {
    selector: '.rec .amt',
    where: '记录金额',
    css: ['.rec .amt', '.card'],
    fg: 'var(--ink)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'index.wxml L106',
    note: '',
  },
  {
    selector: '.amt.danger',
    where: '待结清金额（红）',
    css: ['.amt.danger', '#homeSettle .rec .amt', '.rec .amt'],
    fg: 'var(--danger)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'index.wxml L79 / index.wxss .amt.danger',
    note: '',
  },

  /* ---------------- 标签 / 胶囊 ---------------- */
  {
    selector: '.tag',
    where: '明细页参与人标签 / 记录标签',
    css: ['.tag'],
    fg: 'var(--ink-2)',
    bg: 'var(--surface-2)',
    bgNote: '标签浅灰底',
    source: 'list.wxml L32',
    note: '明细页参与人标签（可点切换）',
  },
  {
    selector: '.tag.ok',
    where: '「已结清」',
    css: ['.tag.ok', '.tag'],
    fg: 'var(--brand-ink)',
    bg: 'var(--brand-soft)',
    bgNote: '品牌浅底',
    source: 'index.js L121',
    note: '',
  },
  {
    selector: '.tag.no',
    where: '「N 人未结」',
    css: ['.tag.no', '.tag'],
    fg: 'var(--danger)',
    bg: 'var(--danger-soft)',
    bgNote: '危险浅底',
    source: 'index.js L121 / list.js L28',
    note: '',
  },
  {
    selector: '.tag.rc',
    where: '「🧾 小票」来源标签',
    css: ['.tag.rc', '.tag'],
    fg: 'var(--ink-3)',
    bg: '#eef2f8',
    bgNote: '蓝色浅底 #eef2f8',
    source: 'index.js L122',
    note: '唯一的蓝灰色，没有走设计变量',
  },
  {
    selector: '.tag.low',
    where: '小票明细「请核对」',
    css: ['.tag.low', '.tag'],
    fg: 'var(--amber)',
    bg: 'var(--amber-soft)',
    bgNote: '琥珀浅底',
    source: 'receipt.wxml',
    note: '',
  },
  {
    selector: '.pill',
    where: '记账人 / 可修改 / 人数',
    css: ['.pill'],
    fg: 'var(--brand-ink)',
    bg: 'var(--brand-soft)',
    bgNote: '品牌浅底',
    source: 'book.wxml L7',
    note: '',
  },
  /* ---------------- 下拉选择组件 components/sheet-select ---------------- */
  {
    selector: '.ss-trigger（收起态取值）',
    where: '类别 / 垫付人 / 服务商 / 找谁 的触发器',
    css: ['.ss-trigger'],
    fg: 'var(--ink)',
    bg: 'var(--surface)',
    bgNote: '白底输入框',
    source: 'components/sheet-select/index.wxml',
    note: '',
  },
  {
    selector: '.ss-trigger.is-empty（占位文案）',
    where: '没选或不可选时的一句话',
    css: ['.ss-trigger.is-empty'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface)',
    bgNote: '白底输入框',
    source: 'components/sheet-select/index.wxml',
    note: '',
  },
  {
    selector: '.ss-title / .ss-sub（面板标题行）',
    where: '下拉面板顶部',
    css: ['.ss-title', '.ss-sub'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface)',
    bgNote: '面板白底',
    source: 'components/sheet-select/index.wxml',
    note: '取较弱的 .ss-sub 计算',
  },
  {
    selector: '.ss-desc（面板行副标题）',
    where: '下拉面板每一行的说明文字',
    css: ['.ss-desc'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface-2)',
    bgNote: '面板行浅灰底',
    source: 'components/sheet-select/index.wxml',
    note: '',
  },
  {
    selector: '.ss-item.on .ss-label（选中行）',
    where: '下拉面板当前选中项',
    css: ['.ss-item.on .ss-label'],
    fg: 'var(--brand-ink)',
    bg: 'var(--brand-soft)',
    bgNote: '选中行品牌浅底',
    source: 'components/sheet-select/index.wxml',
    note: '',
  },
  {
    selector: '.ss-side（面板行右侧金额）',
    where: '「找谁」面板每行金额',
    css: ['.ss-side'],
    fg: 'var(--danger)',
    bg: 'var(--surface-2)',
    bgNote: '面板行浅灰底',
    source: 'components/sheet-select/index.wxml',
    note: '',
  },
  {
    selector: '.ss-cancel（面板取消）',
    where: '下拉面板底部',
    css: ['.ss-cancel'],
    fg: 'var(--ink-2)',
    bg: 'var(--surface)',
    bgNote: '面板白底',
    source: 'components/sheet-select/index.wxml',
    note: '',
  },
  {
    selector: '.confidence',
    where: '识别置信度 / 来源',
    css: ['.confidence'],
    fg: 'var(--brand-ink)',
    bg: 'var(--brand-soft)',
    bgNote: '品牌浅底',
    source: 'book.wxml L34',
    note: '',
  },
  {
    selector: '.ai-badge',
    where: 'AI 标记（遗留规则）',
    css: ['.ai-badge'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface-2)',
    bgNote: '浅灰底',
    source: 'app.wxss（当前 WXML 未引用）',
    note: '全工程最小字号 21rpx≈10.5px',
  },

  /* ---------------- 提示条 / 引用块 ---------------- */
  {
    selector: '.alert',
    where: '首页未结清告警 / 小票警告',
    css: ['.alert'],
    fg: 'var(--amber)',
    bg: 'var(--amber-soft)',
    bgNote: '琥珀浅底',
    source: 'index.wxml L40',
    note: '深褐色硬编码，未走变量',
  },
  {
    selector: '.alert.ok',
    where: '「明细与票面总额一致」',
    css: ['.alert.ok', '.alert'],
    fg: 'var(--brand-ink)',
    bg: 'var(--brand-soft)',
    bgNote: '品牌浅底',
    source: 'receipt.wxml',
    note: '',
  },
  {
    selector: '.quote',
    where: '提醒话术 / 月报正文',
    css: ['.quote'],
    fg: 'var(--ink)',
    bg: [['#f2f8f4'], ['#ebf4ef']],
    bgNote: '渐变最深处',
    source: 'remind.wxml L34 / L81',
    note: '背景是 linear-gradient(180deg,#f2f8f4,#ebf4ef)',
  },

  /* ---------------- 分段控件 / 语气选择 ---------------- */
  {
    selector: '.seg view（未选中）',
    where: '记账页分摊方式 / 明细页筛选',
    css: ['.seg view', '.seg'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface)',
    bgNote: '卡片白底上方的标签条',
    source: 'book.wxml L86 / list.wxml L7',
    note: '',
  },
  {
    selector: '.seg view.on（选中）',
    where: '记账页分摊方式 / 明细页筛选',
    css: ['.seg view.on'],
    fg: 'var(--brand)',
    bg: 'var(--surface)',
    bgNote: '卡片白底',
    source: 'book.wxml L86 / list.wxml L7',
    note: '标签式：绿字 + 下划线，不再是绿底白字',
  },
  {
    selector: '.tone-option（语气名）',
    where: '语气选择（遗留规则）',
    css: ['.tone-name', '.tone-option', '.tone-picker'],
    fg: 'var(--ink-2)',
    bg: 'var(--surface-2)',
    bgNote: '选择器凹槽',
    source: 'app.wxss（当前 WXML 未引用）',
    note: '网页 demo 遗留，小程序已改用原生 picker',
  },
  {
    selector: '.tone-desc',
    where: '语气说明（遗留规则）',
    css: ['.tone-desc', '.tone-picker'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface-2)',
    bgNote: '选择器凹槽',
    source: 'app.wxss（当前 WXML 未引用）',
    note: '',
  },
  {
    selector: '.tone-option.on .tone-desc',
    where: '选中语气说明（遗留规则）',
    css: ['.tone-option.on .tone-desc', '.tone-desc', '.tone-option.on'],
    fg: 'rgba(255,255,255,.88)',
    bg: 'var(--brand)',
    bgNote: '选中品牌底',
    source: 'app.wxss（当前 WXML 未引用）',
    note: '88% 白叠在品牌绿上',
  },

  /* ---------------- 按钮 / 链接 ---------------- */
  {
    selector: '.btn',
    where: '主按钮（记一笔 / 确认入账 / 生成话术）',
    css: ['.btn'],
    fg: '#fff',
    bg: 'var(--brand)',
    bgNote: '品牌主色',
    source: 'index.wxml L112 等',
    note: '',
  },
  {
    selector: '.btn.ghost',
    where: '次按钮（标记已结清 / 取消）',
    css: ['.btn.ghost', '.btn'],
    fg: 'var(--ink-2)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'index.wxml L80',
    note: '',
  },
  {
    selector: '.btn.danger',
    where: '「撤销这笔」',
    css: ['.btn.danger', '.btn'],
    fg: 'var(--danger)',
    bg: 'var(--danger-soft)',
    bgNote: '危险浅底',
    source: 'list.wxml',
    note: '',
  },
  {
    selector: '.btn.sm',
    where: '小尺寸主按钮',
    css: ['.btn.sm'],
    fg: '#fff',
    bg: 'var(--brand)',
    bgNote: '品牌主色',
    source: 'room.wxml 等',
    note: '',
  },
  {
    selector: '.link',
    where: '首页「查看全部 →」',
    css: ['.link'],
    fg: 'var(--brand)',
    bg: 'var(--surface)',
    bgNote: '卡片面',
    source: 'index.wxml L93',
    note: '',
  },

  /* ---------------- 统计块 / 成员账 ---------------- */
  {
    selector: '.stat .k',
    where: '统计块标签',
    css: ['.stat .k', '.stat'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface-2)',
    bgNote: '统计块浅灰底',
    source: 'receipt.wxml',
    note: '',
  },
  {
    selector: '.stat .v',
    where: '统计块数值',
    css: ['.stat .v', '.stat'],
    fg: 'var(--ink)',
    bg: 'var(--surface-2)',
    bgNote: '统计块浅灰底',
    source: 'remind.wxml L55',
    note: '',
  },
  {
    selector: '.stat .v.pos',
    where: '统计块正值',
    css: ['.stat .v.pos', '.stat .v'],
    fg: 'var(--brand)',
    bg: 'var(--surface-2)',
    bgNote: '统计块浅灰底',
    source: 'remind.wxml L67',
    note: '',
  },
  {
    selector: '.stat .v.neg',
    where: '统计块负值',
    css: ['.stat .v.neg', '.stat .v'],
    fg: 'var(--danger)',
    bg: 'var(--surface-2)',
    bgNote: '统计块浅灰底',
    source: 'remind.wxml L67',
    note: '',
  },
  {
    selector: '.people .person .n',
    where: '首页成员姓名',
    css: ['.people .person .n', '.person .n'],
    fg: 'var(--ink-2)',
    bg: 'var(--surface-2)',
    bgNote: '成员块浅灰底',
    source: 'index.wxml L54 / index.wxss L98',
    note: '页面 wxss 覆盖为 26rpx / 600 / ink-2',
  },
  {
    selector: '.people .person .b',
    where: '首页成员金额',
    css: ['.people .person .b', '.person .b'],
    fg: 'var(--ink)',
    bg: 'var(--surface-2)',
    bgNote: '成员块浅灰底',
    source: 'index.wxml L58',
    note: '',
  },
  {
    selector: '.person .b.pos',
    where: '应收（绿）',
    css: ['.person .b.pos', '.people .person .b', '.person .b'],
    fg: 'var(--brand)',
    bg: 'var(--surface-2)',
    bgNote: '成员块浅灰底',
    source: 'index.js L98',
    note: '',
  },
  {
    selector: '.person .b.neg',
    where: '应掏（红）',
    css: ['.person .b.neg', '.people .person .b', '.person .b'],
    fg: 'var(--danger)',
    bg: 'var(--surface-2)',
    bgNote: '成员块浅灰底',
    source: 'index.js L98',
    note: '',
  },
  {
    selector: '.person.out .nm（已退出成员的姓名）',
    where: '首页成员姓名（该成员已退出时）',
    css: ['.people .person .n', '.person.out .nm'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface-2)',
    bgNote: '成员块浅灰底',
    source: 'index.wxml L54 / app.wxss `.person.out .nm{color:var(--ink-3)}`',
    note: '已退出成员不再整体压暗（原 opacity:.72 已删），只把姓名降到 --ink-3，徽标保持原样',
  },
  {
    selector: '.ex（已退出徽标）',
    where: '成员「已退出」徽标',
    css: ['.ex'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface-2)',
    bgNote: '成员块浅灰底',
    source: 'index.wxml L56 / app.wxss `.ex`',
    note: '不透明浅底 + 深色字，不叠 opacity',
  },

  /* ---------------- 房间页 ---------------- */
  {
    selector: '.room-item-meta',
    where: '房间条目副行',
    css: ['.room-item-meta'],
    fg: 'var(--ink-3)',
    bg: 'var(--surface-2)',
    bgNote: '房间条目浅灰底',
    source: 'room.wxml',
    note: '',
  },
  {
    selector: '.room-item-code',
    where: '房间码',
    css: ['.room-item-code'],
    fg: 'var(--brand-ink)',
    bg: 'var(--surface-2)',
    bgNote: '房间条目浅灰底',
    source: 'room.wxml',
    note: '',
  },
  {
    selector: '.room-item-check',
    where: '「当前」标记',
    css: ['.room-item-check'],
    fg: 'var(--brand)',
    bg: 'var(--brand-soft)',
    bgNote: '选中项品牌浅底',
    source: 'room.wxml',
    note: '',
  },
  {
    selector: '.room-code',
    where: '当前房间大号房间码',
    css: ['.room-code'],
    fg: 'var(--brand-ink)',
    bg: 'var(--surface-2)',
    bgNote: '房间块浅灰底',
    source: 'room.wxml L12',
    note: '',
  },

  /* ---------------- 表单控件 ---------------- */
  {
    selector: 'input 输入文字',
    where: '记账 / 小票 / 房间 / 成员输入框',
    css: ['input', 'picker'],
    fg: 'var(--ink)',
    bg: '#fffdf8',
    bgNote: '输入框面 #fffdf8',
    source: 'book.wxml L13 / app.wxss input,picker,textarea',
    note: '元素选择器给了 #fffdf8 底',
  },
  {
    selector: 'placeholder（.ph 占位符）',
    where: '输入框未填写时的灰字',
    css: ['.ph'],
    fg: 'var(--ink-4)',
    bg: '#fffdf8',
    size: 29,
    weight: 400,
    bgNote: '输入框面 #fffdf8',
    source: 'book.wxml placeholder-class="ph" / app.wxss .ph',
    note: '已显式指定 placeholder-class，不再是微信默认灰',
  },
  {
    selector: '.pick .p',
    where: '参与人选择',
    css: ['.pick .p'],
    fg: 'var(--ink-2)',
    bg: '#fffdf8',
    bgNote: '参与人胶囊底 #fffdf8',
    source: 'book.wxml L72',
    note: '',
  },
  {
    selector: '.pick .p.on',
    where: '参与人选中',
    css: ['.pick .p.on', '.pick .p'],
    fg: 'var(--brand-ink)',
    bg: 'var(--brand-soft)',
    bgNote: '选中品牌浅底',
    source: 'book.wxml L72',
    note: '',
  },
  {
    selector: '.day-name',
    where: '按天分摊的人名',
    css: ['.day-name'],
    fg: 'var(--ink-2)',
    bg: 'var(--surface-2)',
    bgNote: '.day 行的浅灰底',
    source: 'book.wxml L93',
    note: '',
  },

  /* ---------------- 折叠块 / 代码 ---------------- */
];

/* ------------------------------------------------------------------ *
 * 7. 审计
 * ------------------------------------------------------------------ */

function normalizeBg(bg) {
  if (typeof bg === 'string') return [[bg]];
  if (Array.isArray(bg)) {
    return bg.map((c) => (typeof c === 'string' ? [c] : c));
  }
  throw new Error('非法 bg 配置: ' + JSON.stringify(bg));
}

function flattenLayers(layers, vars) {
  let acc = { r: 255, g: 255, b: 255, a: 1 };
  for (const expr of layers) {
    const { color } = resolveColor(expr, vars);
    if (!color) continue;
    acc = composite(color, acc);
  }
  return acc;
}

function fmtNum(v, digits = 2) {
  const p = Math.pow(10, digits);
  return String(Math.round(v * p) / p);
}

/** 前景：按 css 顺序找第一个可解析的 color，否则用表内兜底 */
function resolveFg(entry, project, flags) {
  if (entry.css) {
    const hit = firstDecl(project, entry.css, 'color');
    if (hit) {
      const { color } = resolveColor(hit.value, project.vars);
      if (color && color.a > 0) {
        flags.fgFromCss = true;
        return { color, expr: hit.value };
      }
    }
  }
  const { color } = resolveColor(entry.fg, project.vars);
  return { color, expr: entry.fg };
}

/** 背景候选：字符串背景允许被 CSS 覆盖；数组背景是人工建模的叠加，不覆盖 */
function resolveBg(entry, project, flags) {
  if (typeof entry.bg === 'string' && entry.css) {
    const hit = firstDecl(project, entry.css, 'background-color') || firstDecl(project, entry.css, 'background');
    if (hit) {
      const raw = hit.value;
      if (/gradient/i.test(raw)) {
        const cands = [];
        for (const tok of colorTokens(raw)) {
          const { color } = resolveColor(tok, project.vars);
          if (color && color.a > 0) cands.push({ color, expr: raw, layers: [tok] });
        }
        if (cands.length) {
          flags.bgFromCss = true;
          return cands;
        }
      } else {
        const { color } = resolveColor(raw, project.vars);
        if (color && color.a > 0) {
          flags.bgFromCss = true;
          return [{ color, expr: raw, layers: [raw] }];
        }
      }
    }
  }
  return normalizeBg(entry.bg).map((layers) => {
    const { color } = resolveColor(entry.bg, project.vars);
    return {
      color: layers.length === 1 && color ? color : flattenLayers(layers, project.vars),
      expr: typeof entry.bg === 'string' ? entry.bg : JSON.stringify(entry.bg),
      layers,
    };
  });
}

function auditEntry(entry, project) {
  const flags = { fgFromCss: false, bgFromCss: false };
  const warnings = [];

  // 自检：组合表里的选择器若在 WXSS 里已经全部消失（改名/删除），这条就不再审计，
  // 否则会拿表里的旧兜底值算出"看起来没问题"的假数据。
  if (entry.css && entry.css.length) {
    const alive = entry.css.some((sel) => project.declIndex.has(sel));
    if (!alive) return { missing: true, selector: entry.selector };
  }

  // tabBar 走 app.json
  let fgExprRaw = entry.fg;
  let bgExprRaw = entry.bg;
  if (entry.tabBar) {
    const bar = project.appJson && project.appJson.tabBar;
    if (!bar) return null;
    fgExprRaw = bar[entry.tabBar] || '#000';
    bgExprRaw = bar.backgroundColor || '#fff';
  }

  const fgRes = entry.tabBar
    ? { color: parseColor(fgExprRaw), expr: fgExprRaw }
    : resolveFg({ ...entry, fg: entry.fg }, project, flags);
  if (!fgRes.color) {
    warnings.push(`前景「${entry.fg}」无法解析`);
    return null;
  }

  const bgCands = entry.tabBar
    ? [{ color: parseColor(bgExprRaw), expr: bgExprRaw, layers: [bgExprRaw] }].filter((c) => c.color)
    : resolveBg({ ...entry, bg: bgExprRaw }, project, flags);
  if (!bgCands.length) {
    warnings.push('没有可用背景');
    return null;
  }

  // 字号 / 字重
  const cssSize = firstDecl(project, entry.css, 'font-size');
  const cssWeight = firstDecl(project, entry.css, 'font-weight');
  const sizeRpx = entry.size ?? toRpx(cssSize && cssSize.value) ?? 31;
  const weight = entry.weight ?? (parseFloat(String((cssWeight && cssWeight.value) || '')) || 400);

  const opacity = entry.opacity ?? 1;
  let worst = null;
  for (const cand of bgCands) {
    const effAlpha = fgRes.color.a * opacity;
    const eff = composite({ ...fgRes.color, a: effAlpha }, cand.color);
    const ratio = contrastRatio(eff, cand.color);
    if (!worst || ratio < worst.ratio) worst = { bg: cand, eff, ratio, effAlpha };
  }

  const px = sizeRpx / 2;
  const isBold = weight >= 600;
  const isLarge = px >= 24 || (px >= 18.66 && isBold);
  const thrAA = isLarge ? 3 : 4.5;
  const thrAAA = isLarge ? 4.5 : 7;

  const passAA = worst.ratio >= thrAA;
  const passAAA = worst.ratio >= thrAAA;

  // 建议色：先尝试只改前景；前景无解（例如白字已在最亮端）就改底色
  const target = passAA ? thrAAA : thrAA;
  let fix = passAAA ? null : suggestColor(worst.eff, worst.bg.color, target);
  let fixBg = null;
  if (!passAAA && !fix) fixBg = suggestColor(worst.bg.color, worst.eff, target);

  // 去掉元素 opacity（保留颜色自带 alpha）后的比值：用来判断"去掉 opacity 是否就够了"
  const effNoOpacity = composite({ ...fgRes.color, a: fgRes.color.a }, worst.bg.color);
  const ratioNoOpacity = contrastRatio(effNoOpacity, worst.bg.color);

  const tokenOf = (expr) => {
    const m = /^var\((--[\w-]+)/.exec(String(expr));
    return m ? m[1] : null;
  };

  return {
    selector: entry.selector,
    where: entry.where,
    note: entry.note || '',
    source: entry.source || '',
    fgExpr: String(fgExprRaw),
    fgToken: tokenOf(fgRes.expr),
    fgSourceHex: toHex(fgRes.color),
    fgAlpha: fgRes.color.a,
    opacity,
    effHex: toHex(worst.eff),
    effColor: worst.eff,
    bgColor: worst.bg.color,
    bgHex: toHex(worst.bg.color),
    bgExpr: String(worst.bg.expr),
    bgToken: tokenOf(worst.bg.expr),
    bgNote: entry.bgNote || '',
    fgFromCss: entry.tabBar ? true : flags.fgFromCss,
    bgFromCss: entry.tabBar ? true : flags.bgFromCss,
    sizeRpx,
    weight,
    px,
    isLarge,
    thrAA,
    thrAAA,
    ratio: worst.ratio,
    ratioNoOpacity,
    target,
    passAA,
    passAAA,
    fix,
    fixBg,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 8. 报告
 * ------------------------------------------------------------------ */

const LARGE_RULE_TEXT =
  '小字（<24px 且非粗体）AA ≥ 4.5、AAA ≥ 7；大字（≥24px，或 ≥18.66px 且粗体）AA ≥ 3、AAA ≥ 4.5。';

const code = (s) => '`' + s + '`';

function fgCell(r) {
  const mods = [];
  if (r.fgAlpha < 1) mods.push('α' + fmtNum(r.fgAlpha));
  if (r.opacity < 1) mods.push('opacity ' + fmtNum(r.opacity));
  const hex = `${code(r.fgSourceHex)}${mods.length ? ' ' + mods.join(' × ') : ''}`;
  if (r.fgToken) {
    const head = `${code(r.fgToken)}<br>${hex}`;
    return r.effHex !== r.fgSourceHex ? `${head}<br>合成 ${code(r.effHex)}` : head;
  }
  return r.effHex !== r.fgSourceHex ? `${hex}<br>合成 ${code(r.effHex)}` : hex;
}

function bgCell(r) {
  const label = r.bgNote ? `<br>${r.bgNote}` : '';
  return `${code(r.bgHex)}${label}`;
}

function verdictCell(r) {
  const level = r.passAAA ? 'AAA' : r.passAA ? 'AA' : '不合格';
  return `${r.passAA ? '✓' : '✗'} AA ${r.thrAA}<br>${r.passAAA ? '✓' : '✗'} AAA ${r.thrAAA}<br>**${level}**`;
}

function shortSelector(s) {
  return String(s).replace(/（.*?）/g, '').trim();
}

function buildReport(project, rows, meta) {
  const fails = rows.filter((r) => !r.passAA);
  const weak = rows.filter((r) => r.passAA && !r.passAAA);
  const solid = rows.filter((r) => r.passAAA);
  const fallbackRows = rows.filter((r, i) => !r.fgFromCss || !r.bgFromCss);

  const L = [];
  L.push('# 小程序配色对比度审计报告（WCAG 2.1）');
  L.push('');
  L.push('> 工程：`D:\\小组作业\\miniprogram`（寝室公共开支记账小程序）  ');
  L.push(`> 生成时间：${meta.timestamp}  `);
  L.push(`> 代码快照：app.wxss ${meta.appWxssSize} 字节 / 修改于 ${meta.appWxssTime}  `);
  L.push(`> 生成脚本：${code('miniprogram/_tools/contrast-audit.js')}（本报告所有数字由脚本实算，可随时重跑复核）`);
  L.push('');
  L.push('> ⚠ 生成期间 `app.wxss`、`pages/*/` 正在被并行重构（文件时间戳见上）。本报告反映的是**该时刻的代码状态**；');
  L.push('> 设计变量调整后重跑一次即可刷新全部数字，表格无需手工维护。');
  L.push('');

  L.push('## 1. 用途');
  L.push('');
  L.push('给设计系统重构提供**可量化的依据**：把每个组件实际的「前景色 / 背景色 / 字号 / 字重」组合算成 WCAG 对比度，');
  L.push('标出不合格项与临界项，并给出同色相的替换色。用来决定**先改哪几个颜色变量**，而不是凭感觉调色。');
  L.push('');
  L.push('- 审计对象：`app.wxss`（全局限定 + 网页 demo 翻译遗留）+ `pages/*/*.wxss` + `pages/*/*.wxml` 的叠放关系 + `app.json` 的 tabBar 配色。');
  L.push(`- 本次覆盖 ${rows.length} 条组件组合、${meta.ruleCount} 条样式规则、${project.varCount} 个自定义属性、${meta.fileCount} 个 WXSS 文件。`);
  L.push('- 只读取工程文件，不改动任何业务代码。');
  L.push('');

  L.push('## 2. 运行方式');
  L.push('');
  L.push('```powershell');
  L.push('# 在项目根 D:\\小组作业 下执行');
  L.push('node miniprogram\\_tools\\contrast-audit.js');
  L.push('```');
  L.push('');
  L.push('输出：');
  L.push('');
  L.push('- `miniprogram/_audit/contrast-report.md`（本文件）');
  L.push('- `miniprogram/_audit/contrast-data.json`（同样的数据，给工具/后续脚本消费）');
  L.push('');
  L.push('脚本每次运行都会重新解析 `app.wxss` 的 `page{}` 变量、各组件的颜色与字号，所以改了色值或字号后');
  L.push('重跑一次即可得到新结论——**报告里的数字不会和代码脱节**。');
  L.push('');

  L.push('## 3. 判定标准');
  L.push('');
  L.push('WCAG 2.1 对比度：`(L_亮 + 0.05) / (L_暗 + 0.05)`，L 为 sRGB 线性化后的相对亮度。');
  L.push('');
  L.push(`- ${LARGE_RULE_TEXT}`);
  L.push('- 字号换算：微信小程序 `rpx` 按 750rpx = 375px 基准折算，**1rpx = 0.5px**（375pt 屏；大屏机实际略大，此处偏严）。');
  L.push('- 半透明前景（如 `--on-header-2`）与带 `opacity` 的元素，**先按 alpha 合成到底色再算**，不用名义色值。');
  L.push('- 渐变背景取**对比度最差的那个采样点**作为结论（深色头部取最亮处，浅色卡片取最深处的采样）。');
  L.push('- 粗体判定：`font-weight ≥ 600`（本工程大量使用 550/650）。');
  L.push('');

  L.push('## 4. 结论速览');
  L.push('');
  L.push('| 指标 | 数量 |');
  L.push('| --- | --- |');
  L.push(`| 审计组合总数 | ${rows.length} |`);
  L.push(`| **AA 不合格（必须改）** | **${fails.length}** |`);
  L.push(`| 达标 AA 但不到 AAA（建议改） | ${weak.length} |`);
  L.push(`| 达标 AAA | ${solid.length} |`);
  L.push('');
  L.push('最差的 5 条：');
  L.push('');
  L.push('| 组件 | 比值 | 判定 |');
  L.push('| --- | --- | --- |');
  for (const r of rows.slice(0, 5)) {
    L.push(`| ${r.selector} | ${fmtNum(r.ratio)} | ${r.passAAA ? 'AAA' : r.passAA ? 'AA' : '**不合格**'} |`);
  }
  L.push('');

  L.push('## 5. 全量明细（按比值升序）');
  L.push('');
  L.push('| # | 组件 / 位置 | 前景 | 背景 | 字号 / 字重 | 比值 | 判定（AA / AAA 门槛） | 建议色 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  rows.forEach((r, i) => {
    const size = `${fmtNum(r.px)}px<br>${fmtNum(r.sizeRpx)}rpx / ${r.weight}${r.isLarge ? '<br>大字' : ''}`;
    const fixCell = r.fix
      ? `${code(toHex(r.fix.color))}<br>${fmtNum(r.fix.ratio)}`
      : r.fixBg
        ? `${code(toHex(r.fixBg.color))}（改底色）<br>${fmtNum(r.fixBg.ratio)}`
        : '—';
    L.push(
      `| ${i + 1} | ${r.selector}${r.note ? '<br><sub>' + r.note + '</sub>' : ''} | ${fgCell(r)} | ${bgCell(r)} | ${size} | **${fmtNum(r.ratio)}** | ${verdictCell(r)} | ${fixCell} |`
    );
  });
  L.push('');
  L.push('> 建议色按「保持色相与饱和度、只调明度」反解，目标是刚好越过门槛（AA 不合格项按 AA 门槛，仅 AAA 不足项按 AAA 门槛）。');
  L.push('> 对半透明 / 带 opacity 的前景，建议色给的是**不透明替代值**——直接换成该 hex 即可达到括注的比值。');
  L.push('');

  L.push('## 6. 必须改（AA 不合格）');
  L.push('');
  if (!fails.length) {
    L.push('无。');
  } else {
    L.push('| 组件 / 位置 | 前景 | 背景 | 比值 | 门槛 | 建议改为 | 改后比值 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of fails) {
      const fgTxt = r.fgToken ? `${code(r.fgToken)} ${code(r.fgSourceHex)}` : code(r.fgSourceHex);
      const fixTxt = r.fix ? code(toHex(r.fix.color)) : r.fixBg ? code(toHex(r.fixBg.color)) + '（底）' : '—';
      const afterTxt = r.fix ? fmtNum(r.fix.ratio) : r.fixBg ? fmtNum(r.fixBg.ratio) : '—';
      L.push(
        `| ${r.selector}<br><sub>${r.where}</sub> | ${fgTxt}${r.fgAlpha < 1 ? ' α' + fmtNum(r.fgAlpha) : ''}${r.opacity < 1 ? ' × opacity ' + fmtNum(r.opacity) : ''} | ${code(r.bgHex)} | **${fmtNum(r.ratio)}** | ${r.thrAA} | ${fixTxt} | ${afterTxt} |`
      );
    }
  }
  L.push('');
  if (fails.length) {
    L.push('改法：');
    L.push('');
    const opFails = fails.filter((r) => r.opacity < 1);
    const colorFails = fails.filter((r) => r.opacity >= 1);
    if (opFails.length) {
      const detail = opFails
        .map((r) => `${r.selector.replace(/（.*?）/g, '')} ${fmtNum(r.ratio)} → ${fmtNum(r.ratioNoOpacity)}`)
        .join('，');
      L.push(`- **这 ${opFails.length} 条其实是同一个原因：整体 \`opacity:${fmtNum(opFails[0].opacity)}\`，不是色值不够深**（去掉透明度后：${detail}）。所以最省事的一步是：`);
      L.push('  1. 删掉 `.person.out` 上的整体透明度——"已退出"改用「灰底 + 徽标」表达，别再整体压暗；');
      L.push('  2. 一定要淡化的话，`opacity` 至少提到 0.9，或只给徽标本身设不透明浅底，别让姓名跟着一起掉；');
      L.push('  3. 要保留 72% 的观感就把字色调到更深再乘透明度（本报告给的建议色是**不透明**替代值，不能按原样叠 opacity）。');
    }
    for (const r of colorFails) {
      if (r.fix) {
        L.push(`- **${r.selector}**（${r.where}）：${fmtNum(r.ratio)} < ${r.thrAA}，建议改为 ${code(toHex(r.fix.color))}（${fmtNum(r.fix.ratio)}）。`);
      } else if (r.fixBg) {
        L.push(`- **${r.selector}**（${r.where}）：${fmtNum(r.ratio)} < ${r.thrAA}，字色已无可调空间，需要把底色调深到 ${code(toHex(r.fixBg.color))}（${fmtNum(r.fixBg.ratio)}）。`);
      }
    }
  }
  L.push('');

  L.push('## 7. 建议改（AA 达标，AAA 未达标）');
  L.push('');
  L.push('这些不算"错误"，但一屏里密集出现时会让人觉得"字发灰、费眼"——正对应"文字与背景对比度太小"的观感。');
  L.push('按「前景 × 背景」分组，改一处即可同时解决整组：');
  L.push('');
  const groups = new Map();
  for (const r of weak) {
    const key = `${r.fgExpr}|${r.bgHex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const groupArr = [...groups.values()].map((list) => {
    const worst = list.reduce((a, b) => (b.ratio < a.ratio ? b : a), list[0]);
    const tgt = worst.thrAAA;
    let fix = suggestColor(worst.effColor, worst.bgColor, tgt);
    let fixBg = null;
    if (!fix) fixBg = suggestColor(worst.bgColor, worst.effColor, tgt);
    return { list, worst, target: tgt, fix, fixBg };
  });
  groupArr.sort((a, b) => a.worst.ratio - b.worst.ratio);

  L.push('| 组（前景 × 背景） | 涉及组件 | 条数 | 当前最低 | 目标 | 建议色 | 改后 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const g of groupArr) {
    const w = g.worst;
    const src = parseColor(w.fgSourceHex) || w.effColor;
    const fgName = w.fgToken
      ? code(w.fgToken)
      : w.fgAlpha < 1
        ? 'rgba(' + [clampByte(src.r), clampByte(src.g), clampByte(src.b)].join(',') + ',' + fmtNum(w.fgAlpha) + ')'
        : code(w.fgSourceHex);
    const names = g.list.map((r) => '`' + shortSelector(r.selector) + '`').join('、');
    const fixTxt = g.fix ? code(toHex(g.fix.color)) : g.fixBg ? code(toHex(g.fixBg.color)) + '（底）' : '—';
    const afterTxt = g.fix ? fmtNum(g.fix.ratio) : g.fixBg ? fmtNum(g.fixBg.ratio) : '—';
    L.push(
      `| ${fgName} × ${code(w.bgHex)} | ${names} | ${g.list.length} | **${fmtNum(w.ratio)}** | ${g.target} | ${fixTxt} | ${afterTxt} |`
    );
  }
  L.push('');
  const ink3Count = rows.filter((r) => r.fgToken === '--ink-3').length;
  L.push(`优先动**设计变量**，别逐个改选择器：上表里同一个 \`--ink-3\` 就横跨 ${ink3Count} 个组件，改一次全解决。`);
  L.push('标「（底）」的是"字色已到极限、只能动底色"的情况——比如白字压品牌绿，白已是最亮端，只能把绿压深。');
  L.push('');

  L.push('## 8. 方法说明与局限');
  L.push('');
  L.push('**做法**');
  L.push('');
  L.push('1. 解析全部 `*.wxss` 成规则表（选择器 → 声明，跳过 `@media` 覆盖以保证可重复），取出 `page{}` 的 CSS 自定义属性，支持 `var(--x, fallback)` 的嵌套 fallback 链。');
  L.push('2. 读 `pages/*/*.wxml` 确认每个组合的**真实叠放**：谁在谁里面、有没有再叠一层半透明底（`.icon-btn` 的 `rgba(255,255,255,.07)`）、有没有 `opacity`（`.ex` 的 `.72`）。');
  L.push('3. 颜色优先按组件选择器从 WXSS 实时读取（页面 wxss 覆盖优先），所以 Lead 改 `--ink-*` 之类的变量后数字自动跟着变；读不到才用组合表的兜底值。');
  L.push('4. 半透明前景先 alpha 合成到背景；渐变背景取最差采样点；再算比值。');
  L.push('5. 字号/字重同样按选择器实时读取（如 `.people .person .n` 取 `index.wxss` 覆盖后的 26rpx），读不到用表内兜底值。');
  L.push('');
  L.push('**局限（请知悉后再据此改色）**');
  L.push('');
  L.push('- 深色头部 `.topbar` 背景 = 132° 线性渐变 + 左上角径向金色光斑 + `::before` 的 3.5% 白色扫描线。扫描线按全覆盖计入（偏保守）；金色光斑只对左上角的 `.brand-kicker` 计入，按文字所在位置已衰减到 ≤10% 估算（光斑中心在元素上方 -30% 处）。');
  L.push(`- \`.hero-meta\`（66% 白叠在头部 4% 白底上）实测 **${meta.heroMetaRatio}:1**，但 \`index.wxss\` 已 \`display:none\`，不影响真实页面，未计入表内。`);
  L.push(`- 占位符现由 \`.ph{color:var(--ink-4)}\` 显式控制；若哪天漏写 \`placeholder-class\`，会退回微信默认 \`rgba(0,0,0,.3)\`，在输入框底上只有 **${meta.placeholderAltRatio}:1**。`);
  L.push('- tabBar 由系统渲染，字号按约 10px 估算；它的两个色值来自 `app.json`，脚本直接读 JSON。');
  L.push('- 标了「遗留规则」的条目（`.tone-*`）当前 WXML 未引用，属网页 demo 翻译残留；改版时可直接删，不必调色。');
  if (meta.missingRows && meta.missingRows.length) {
    L.push(`- 以下组合的选择器在本轮重构中已从 WXSS 消失，脚本已自动剔除（不拿旧值充数）：${meta.missingRows.map((s) => code(s)).join('、')}。`);
  }
  if (fallbackRows.length) {
    L.push(`- 有 ${fallbackRows.length} 条组合的前景或背景不是自身声明、而是从父级容器继承的（组合表里记的是父级底色）。它们同样走 CSS 变量解析，改变量会自动更新；只有选择器改名时才需要同步改表。`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push(`<sub>由 \`contrast-audit.js\` 生成 · ${meta.fileCount} 个 WXSS / ${meta.wxmlCount} 个 WXML · Node ${process.version}</sub>`);
  L.push('');
  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * 9. main
 * ------------------------------------------------------------------ */

function main() {
  const project = loadProject();
  if (!project.rules.length) {
    console.error('没有解析到任何 WXSS 规则，检查 miniprogram/app.wxss 路径。');
    process.exit(1);
  }

  const globalWarnings = [];

  // 变量自检
  const usedVars = new Set();
  const collect = (expr) => {
    const re = /var\((--[\w-]+)/g;
    let m;
    while ((m = re.exec(String(expr)))) usedVars.add(m[1]);
  };
  for (const e of ENTRIES) {
    if (e.tabBar) continue;
    collect(e.fg);
    for (const cand of normalizeBg(e.bg)) for (const l of cand) collect(l);
  }
  for (const v of usedVars) if (!(v in project.vars)) globalWarnings.push(`组合表引用了不存在的变量 ${v}`);

  const rows = [];
  const missingRows = [];
  for (const entry of ENTRIES) {
    const r = auditEntry(entry, project);
    if (!r) {
      globalWarnings.push(`跳过无法审计的条目：${entry.selector}`);
      continue;
    }
    if (r.missing) {
      missingRows.push(entry.selector);
      continue;
    }
    rows.push(r);
    for (const w of r.warnings) globalWarnings.push(`${entry.selector}: ${w}`);
  }
  rows.sort((a, b) => a.ratio - b.ratio);

  // 占位符漏配 placeholder-class 时的敏感性（rgba(0,0,0,.3) 先合成到输入框底）
  const inputRow = rows.find((r) => /^input/.test(r.selector));
  const placeholderAltRatio = inputRow
    ? Math.round(contrastRatio(composite({ r: 0, g: 0, b: 0, a: 0.3 }, inputRow.bgColor), inputRow.bgColor) * 100) / 100
    : 0;

  // .hero-meta 的实测值（已 display:none，只写进局限说明）
  const heroMetaBg = flattenLayers(['#0f3d2e', SCANLINE, 'rgba(255,255,255,.04)'], project.vars);
  const heroMetaRatio =
    Math.round(contrastRatio(composite({ r: 247, g: 242, b: 230, a: 0.66 }, heroMetaBg), heroMetaBg) * 100) / 100;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const appWxssPath = path.join(MP_DIR, 'app.wxss');
  const appStat = fs.statSync(appWxssPath);
  const fmtTime = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const meta = {
    timestamp,
    ruleCount: project.rules.length,
    fileCount: project.wxssFiles.length,
    wxmlCount: project.wxmlFiles.length,
    placeholderAltRatio,
    heroMetaRatio,
    missingRows,
    appWxssSize: appStat.size,
    appWxssTime: fmtTime(appStat.mtime),
  };

  const report = buildReport(project, rows, meta);

  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const reportPath = path.join(AUDIT_DIR, 'contrast-report.md');
  const dataPath = path.join(AUDIT_DIR, 'contrast-data.json');
  fs.writeFileSync(reportPath, report, 'utf8');

  const data = {
    generatedAt: now.toISOString(),
    project: MP_DIR,
    appWxss: { size: appStat.size, mtime: appStat.mtime.toISOString() },
    thresholdRule: LARGE_RULE_TEXT,
    rpxToPx: 0.5,
    vars: project.vars,
    summary: {
      total: rows.length,
      fail: rows.filter((r) => !r.passAA).length,
      weak: rows.filter((r) => r.passAA && !r.passAAA).length,
      aaa: rows.filter((r) => r.passAAA).length,
    },
    entries: rows.map((r) => ({
      selector: r.selector,
      where: r.where,
      source: r.source,
      note: r.note,
      fg: { token: r.fgToken, expr: r.fgExpr, hex: r.fgSourceHex, alpha: r.fgAlpha, opacity: r.opacity, effectiveHex: r.effHex, fromCss: r.fgFromCss },
      bg: { token: r.bgToken, hex: r.bgHex, note: r.bgNote, fromCss: r.bgFromCss },
      size: { px: r.px, rpx: r.sizeRpx, weight: r.weight, large: r.isLarge },
      ratio: Math.round(r.ratio * 1000) / 1000,
      ratioWithoutOpacity: Math.round(r.ratioNoOpacity * 1000) / 1000,
      thresholds: { AA: r.thrAA, AAA: r.thrAAA },
      passAA: r.passAA,
      passAAA: r.passAAA,
      suggestion: r.fix ? { hex: toHex(r.fix.color), ratio: Math.round(r.fix.ratio * 1000) / 1000 } : null,
      suggestionBg: r.fixBg ? { hex: toHex(r.fixBg.color), ratio: Math.round(r.fixBg.ratio * 1000) / 1000 } : null,
    })),
    warnings: globalWarnings,
  };
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');

  // 控制台摘要
  const fails = rows.filter((r) => !r.passAA);
  const weak = rows.filter((r) => r.passAA && !r.passAAA);
  const out = (s) => process.stdout.write(s + '\n');
  out('');
  out('对比度审计（WCAG 2.1）');
  out(`  WXSS ${project.wxssFiles.length} 个 / 规则 ${project.rules.length} 条 / 变量 ${project.varCount} 个`);
  out(`  组合 ${rows.length} 条：不合格 ${fails.length}，仅达 AA ${weak.length}，达 AAA ${rows.length - fails.length - weak.length}`);
  out('');
  out('最差的 5 条：');
  for (const r of rows.slice(0, 5)) {
    const mark = r.passAAA ? 'AAA' : r.passAA ? 'AA ' : 'XX ';
    const sug = r.fix ? ` -> 建议 ${toHex(r.fix.color)}（${fmtNum(r.fix.ratio)}）` : r.fixBg ? ` -> 建议底色 ${toHex(r.fixBg.color)}（${fmtNum(r.fixBg.ratio)}）` : '';
    out(`  ${mark} ${fmtNum(r.ratio).padStart(6)}  ${r.selector}  [${r.fgSourceHex} on ${r.bgHex}]${sug}`);
  }
  if (globalWarnings.length) {
    out('');
    out('警告：');
    for (const w of globalWarnings) out('  - ' + w);
  }
  out('');
  out(`报告：${REL(reportPath)}`);
  out(`数据：${REL(dataPath)}`);
  out('');
}

main();
