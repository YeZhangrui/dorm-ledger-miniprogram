#!/usr/bin/env node
'use strict';

/**
 * static-audit.js —— 微信小程序工程静态 bug 扫描（零依赖）
 *
 * 用法（在 D:\小组作业 下）：
 *   node miniprogram\_tools\static-audit.js
 *
 * 只读扫描：不会修改 app.wxss / pages / app.json 等任何工程文件。
 * 唯一写入：miniprogram\_audit\static-audit-result.json（机器可读结果，便于对比两次运行差异）。
 *
 * 退出码：存在「严重」问题时为 1，否则 0（可当 CI 钩子用）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(ROOT, '_audit');
const JSON_OUT = path.join(AUDIT_DIR, 'static-audit-result.json');

const SEV = { CRIT: '严重', MAJOR: '一般', MINOR: '提示' };
const SEV_ORDER = [SEV.CRIT, SEV.MAJOR, SEV.MINOR];

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', green: '\x1b[32m', gray: '\x1b[90m'
};
function paint(s, color) { return USE_COLOR ? color + s + C.reset : s; }

/* ------------------------------------------------------------------ *
 * 0. 基础工具
 * ------------------------------------------------------------------ */

function readText(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, '\n');
}

function exists(p) {
  try { fs.statSync(p); return true; } catch (e) { return false; }
}

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

/** 行/列索引：把 offset 映射成 1 基的行号 */
function makeLocator(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return function locate(offset) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - starts[lo] + 1 };
  };
}

/** 把注释（以及可选字符串内容）替换成等长空格，保持下标不变 */
function mask(code, opts) {
  const o = opts || {};
  const blank = (s, from, to) => s.slice(0, from) + s.slice(from, to).replace(/[^\n]/g, ' ') + s.slice(to);
  let out = code;
  let i = 0;
  while (i < out.length) {
    const ch = out[i], nx = out[i + 1];
    if (ch === '/' && nx === '/') {
      let j = out.indexOf('\n', i);
      if (j < 0) j = out.length;
      out = blank(out, i, j);
      i = j;
      continue;
    }
    if (ch === '/' && nx === '*') {
      let j = out.indexOf('*/', i + 2);
      j = j < 0 ? out.length : j + 2;
      out = blank(out, i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < out.length) {
        if (out[j] === '\\') { j += 2; continue; }
        if (out[j] === ch) break;
        if (ch !== '`' && out[j] === '\n') break; // 未闭合的普通字符串
        j++;
      }
      const end = Math.min(j + 1, out.length);
      if (o.strings === false) { i = end; continue; }
      // 保留引号，内容抹成空格
      out = out.slice(0, i + 1) + out.slice(i + 1, end - 1).replace(/[^\n]/g, ' ') + out.slice(end - 1);
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

function walkFiles(dir, exts, out) {
  if (!exists(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, exts, out);
    else if (exts.includes(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. 工程清单
 * ------------------------------------------------------------------ */

const findings = []; // 全局命中，供最终按级别汇总
function addFinding(check, file, line, message, severity, extra) {
  const f = {
    check: check.id,
    severity: severity,
    file: file,
    line: line || 0,
    message: message
  };
  if (extra && extra.snippet) f.snippet = extra.snippet;
  if (extra && extra.col) f.col = extra.col;
  findings.push(f);
  return f;
}

let APP_JSON = null;
let appJsonError = null;

function loadJson(file) {
  const text = readText(file);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const WXML_FILES = walkFiles(path.join(ROOT, 'pages'), ['.wxml'], []);
const WXSS_FILES = walkFiles(path.join(ROOT, 'pages'), ['.wxss'], []);
const JS_FILES = walkFiles(path.join(ROOT, 'pages'), ['.js'], []);
const JSON_FILES = walkFiles(path.join(ROOT, 'pages'), ['.json'], []);

const APP_WXSS_PATH = path.join(ROOT, 'app.wxss');
const APP_WXSS = exists(APP_WXSS_PATH) ? readText(APP_WXSS_PATH) : '';

/* 读取 app.json */
(function loadAppJson() {
  const p = path.join(ROOT, 'app.json');
  if (!exists(p)) { appJsonError = 'app.json 不存在'; return; }
  const r = loadJson(p);
  if (!r.ok) { appJsonError = r.error; return; }
  APP_JSON = r.value;
})();

/* ------------------------------------------------------------------ *
 * 2. CSS / WXSS 解析
 * ------------------------------------------------------------------ */

/** 解析 wxss 成规则列表（含 @media 等嵌套上下文） */
function parseCssRules(css) {
  const masked = mask(css, { strings: false });
  const locator = makeLocator(css);
  const rules = [];

  function parseBlock(from, to, ctx) {
    let i = from;
    while (i < to) {
      // 找下一个 '{'
      const braceIdx = masked.indexOf('{', i);
      if (braceIdx < 0 || braceIdx >= to) break;
      // 选择器 = 上一个 '}' 或块起点 到 '{' 之间
      const selStart = i;
      const selector = masked.slice(selStart, braceIdx).trim();
      // 求匹配的 '}'
      let depth = 0, j = braceIdx;
      for (; j < to; j++) {
        if (masked[j] === '{') depth++;
        else if (masked[j] === '}') { depth--; if (depth === 0) break; }
      }
      const bodyStart = braceIdx + 1;
      const bodyEnd = Math.min(j, to);
      const body = css.slice(bodyStart, bodyEnd);
      const declOffset = selStart + masked.slice(selStart, braceIdx).indexOf(selector);

      if (!selector) { i = bodyEnd + 1; continue; }

      if (selector[0] === '@') {
        // at-rule：@media/@keyframes 等，递归解析内部
        parseBlock(bodyStart, bodyEnd, { atRule: selector, atStart: declOffset });
      } else {
        const loc = locator(selStart + (masked.slice(selStart, braceIdx).length - masked.slice(selStart, braceIdx).trimStart().length));
        rules.push({
          selector: selector.replace(/\s+/g, ' '),
          body: body,
          line: loc.line,
          atRule: ctx ? ctx.atRule : null,
          atLine: ctx ? locator(ctx.atStart).line : null,
          offset: declOffset
        });
      }
      i = bodyEnd + 1;
    }
  }

  parseBlock(0, masked.length, null);
  return { rules, locator };
}

/** 从选择器里拆出：所有 class；最后一个复合选择器里的 class（= 真正被命中的元素） */
function selectorClasses(selector) {
  const all = new Set();
  const subject = new Set();
  // 先按逗号拆成选择器组，再按组合符拆复合选择器
  selector.split(',').forEach((group) => {
    const cleaned = group.replace(/::?[a-zA-Z-]+\([^)]*\)/g, ' ');
    const parts = cleaned.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    const grab = (part) => {
      const m = part.match(/\.(-?[_a-zA-Z][\w-]*)/g);
      if (m) m.forEach((x) => all.add(x.slice(1)));
      return m ? m.map((x) => x.slice(1)) : [];
    };
    parts.forEach(grab);
    if (parts.length) {
      const last = parts[parts.length - 1].replace(/::?[a-zA-Z-]+/g, '');
      grab(last).forEach((c) => subject.add(c));
    }
  });
  return { all, subject };
}

/** 属性选择器 / 元素选择器 等拆解（逗号先拆组） */
function selectorCompounds(selector) {
  const out = [];
  selector.split(',').forEach((group) => {
    const cleaned = group.replace(/::?[a-zA-Z-]+\([^)]*\)/g, ' ');
    cleaned.split(/\s*[>+~]\s*|\s+/).filter(Boolean).forEach((c) => out.push(c));
  });
  return out;
}

/* 不在小程序里存在的 HTML 元素（WXSS 里写它们等于死规则） */
const WEB_ONLY_TAGS = new Set([
  'html', 'body', 'head', 'main', 'header', 'footer', 'nav', 'section', 'article', 'aside',
  'div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'th', 'td', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em',
  'b', 'i', 'u', 's', 'small', 'big', 'sub', 'sup', 'code', 'pre', 'kbd', 'samp', 'var',
  'blockquote', 'q', 'cite', 'figure', 'figcaption', 'img', 'picture', 'source', 'svg',
  'path', 'g', 'circle', 'rect', 'line', 'polygon', 'polyline', 'use', 'details', 'summary',
  'dialog', 'iframe', 'embed', 'object', 'video2', 'hr', 'br', 'fieldset', 'legend',
  'select', 'option', 'optgroup', 'datalist', 'output', 'meter', 'address', 'abbr', 'mark',
  'time', 'ins', 'del', 'dfn', 'bdi', 'bdo', 'wbr', 'noscript', 'template2'
]);

/** 小程序真实存在的组件（元素选择器合法） */
const MINI_TAGS = new Set(('page view scroll-view swiper swiper-item match-media movable-area movable-view '
  + 'cover-view cover-image icon text rich-text progress button checkbox checkbox-group form input '
  + 'label picker picker-view picker-view-column radio radio-group slider switch textarea navigator '
  + 'audio image video camera canvas ad official-account open-data web-view editor root-portal '
  + 'navigation-bar page-meta share-element slot').split(/\s+/));

/** 伪元素白名单 */
const OK_PSEUDO_ELEMENTS = new Set(['before', 'after']);

/* 解析全部 wxss：app.wxss + 各页 wxss */
const CSS_FILES = [];
(function collectCss() {
  if (APP_WXSS) CSS_FILES.push({ file: APP_WXSS_PATH, css: APP_WXSS, isApp: true });
  WXSS_FILES.forEach((p) => CSS_FILES.push({ file: p, css: readText(p), isApp: false }));
})();

const cssParsed = CSS_FILES.map((f) => ({ file: f.file, isApp: f.isApp, css: f.css, parsed: parseCssRules(f.css) }));

/* 全局 class 表： subject / any */
const definedSubject = new Set();
const definedAny = new Set();
/* 每个 wxss 文件独立统计（用于「本页 wxss 是否定义」） */
const perFileClasses = new Map(); // file -> {subject:Set, any:Set}

cssParsed.forEach(({ file, parsed }) => {
  const subj = new Set(), all = new Set();
  parsed.rules.forEach((r) => {
    const { all: a, subject: s } = selectorClasses(r.selector);
    a.forEach((x) => { all.add(x); definedAny.add(x); });
    s.forEach((x) => { subj.add(x); definedSubject.add(x); });
  });
  perFileClasses.set(file, { subject: subj, any: all });
});

/* 全局 CSS 变量 */
const cssVarDefs = new Map(); // name -> [{file,line,inPage}]
const cssVarUses = [];        // {name, file, line, inWxml}
(function collectVars() {
  cssParsed.forEach(({ file, parsed }) => {
    parsed.rules.forEach((r) => {
      const loc = parsed.locator(r.offset);
      const isPage = /(^|,)\s*page\b/.test(r.selector);
      const re = /(--[A-Za-z0-9_-]+)\s*:/g;
      let m;
      while ((m = re.exec(r.body))) {
        const name = m[1];
        if (!cssVarDefs.has(name)) cssVarDefs.set(name, []);
        cssVarDefs.get(name).push({ file, line: loc.line, inPage: isPage });
      }
    });
  });
  // 使用点（含 wxml 内联 style，稍后补）
  cssParsed.forEach(({ file, parsed }) => {
    const re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
    parsed.rules.forEach((r) => {
      const loc = parsed.locator(r.offset);
      let m;
      while ((m = re.exec(r.body))) {
        cssVarUses.push({ name: m[1], file, line: loc.line, inWxml: false });
      }
    });
  });
})();

/* ------------------------------------------------------------------ *
 * 3. WXML 解析
 * ------------------------------------------------------------------ */

const BUILTIN_TAGS = new Set(('view text image scroll-view swiper swiper-item block button input '
  + 'textarea picker picker-view radio radio-group checkbox checkbox-group switch slider form label '
  + 'navigator icon rich-text progress video audio canvas map cover-view cover-image camera '
  + 'movable-view movable-area open-data web-view ad official-account template import include wxs '
  + 'editor page-meta navigation-bar match-media root-portal share-element slot').split(/\s+/));

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

function parseWxml(src) {
  const clean = mask(src, { strings: false }); // 抹掉 <!-- --> 注释，保持下标
  const locator = makeLocator(src);
  const tags = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(clean))) {
    const raw = m[0];
    const attrRaw = m[3] || '';
    const loc = locator(m.index);
    tags.push({
      isClose: m[1] === '/',
      name: m[2].toLowerCase(),
      attrs: attrRaw,
      selfClosing: m[4] === '/' || /\/\s*>$/.test(raw),
      start: m.index,
      end: m.index + raw.length,
      index: tags.length,
      line: loc.line,
      col: loc.col,
      raw: src.slice(m.index, m.index + raw.length)
    });
  }
  return { clean, locator, tags };
}

function hasAttr(tag, name) {
  return new RegExp('(^|\\s)' + name.replace(/[-:]/g, '\\$&') + '\\s*=').test(tag.attrs);
}

function getAttr(tag, name) {
  const re = new RegExp('(?:^|\\s)' + name.replace(/[-:]/g, '\\$&') + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')');
  const m = tag.attrs.match(re);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

const wxmlParsed = WXML_FILES.map((p) => ({ file: p, src: readText(p), parsed: parseWxml(readText(p)) }));

/* 页面对应关系 */
function pageJsOf(wxmlPath) {
  return wxmlPath.replace(/\.wxml$/, '.js');
}
function pageWxssOf(wxmlPath) {
  return wxmlPath.replace(/\.wxml$/, '.wxss');
}

/* ------------------------------------------------------------------ *
 * 4. 各项检查
 * ------------------------------------------------------------------ */

const CHECKS = [];
function defCheck(id, title) {
  const c = { id, title, findings: [], note: '' };
  CHECKS.push(c);
  return c;
}
function push(check, file, line, message, severity, extra) {
  const f = addFinding(check, file, line, message, severity, extra);
  check.findings.push(f);
  return f;
}

/* ---- 公共：解析 Page({ ... }) 的顶层成员 ---- */
const pageMemberCache = new Map();
function parsePageMembers(jsSrc) {
  const masked = mask(jsSrc, { strings: true });
  const idx = masked.indexOf('Page(');
  if (idx < 0) return null;
  let i = masked.indexOf('{', idx);
  if (i < 0) return null;
  const bodyStart = i + 1;
  let depth = 0, end = masked.length;
  for (let j = i; j < masked.length; j++) {
    if (masked[j] === '{') depth++;
    else if (masked[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  // 按「深度 0 的逗号」切段，每段 = 一个顶层成员
  const segments = [];
  let segStart = bodyStart, d = 0;
  for (let j = bodyStart; j < end; j++) {
    const ch = masked[j];
    if (ch === '{' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === ')' || ch === ']') d--;
    else if (ch === ',' && d === 0) { segments.push([segStart, j]); segStart = j + 1; }
  }
  segments.push([segStart, end]);

  const all = new Set();
  const funcs = new Set();
  const dataSeg = [];
  segments.forEach(([a, b]) => {
    const maskedSeg = masked.slice(a, b); // 用抹掉注释/字符串的版本做结构判定
    const t = maskedSeg.trim();
    if (!t) return;
    let m;
    if ((m = t.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function\b/))) {
      all.add(m[1]); funcs.add(m[1]);
    } else if ((m = t.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/))) {
      all.add(m[1]); funcs.add(m[1]);
    } else if ((m = t.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/))) {
      all.add(m[1]); funcs.add(m[1]);
    } else if ((m = t.match(/^([A-Za-z_$][\w$]*)\s*:/))) {
      all.add(m[1]);
      if (m[1] === 'data') dataSeg.push(maskedSeg);
    }
  });
  return { all, funcs, dataRaw: dataSeg.join('\n') };
}

/** 取一个对象字面量文本里的顶层 key */
function topLevelKeys(raw) {
  const out = new Set();
  const masked = mask(raw, { strings: true });
  const open = masked.indexOf('{');
  if (open < 0) return out;
  let depth = 0, end = masked.length;
  for (let j = open; j < masked.length; j++) {
    if (masked[j] === '{') depth++;
    else if (masked[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  let segStart = open + 1, d = 0;
  for (let j = open + 1; j < end; j++) {
    const ch = masked[j];
    if (ch === '{' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === ')' || ch === ']') d--;
    else if (ch === ',' && d === 0) {
      const seg = masked.slice(segStart, j); // 必须用 masked：注释会挡住 ^key 匹配
      const m = seg.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
      if (m) out.add(m[1]);
      segStart = j + 1;
    }
  }
  const seg = masked.slice(segStart, end);
  const m = seg.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
  if (m) out.add(m[1]);
  return out;
}

/** 页面 js 的 data 键 = data:{...} 顶层键 ∪ 所有 setData({...}) 顶层键 */
function collectDataKeys(jsSrc, members) {
  const keys = new Set();
  if (members && members.dataRaw) {
    topLevelKeys(members.dataRaw).forEach((k) => keys.add(k));
  }
  const re = /\.setData\(\s*\{/g;
  let m;
  while ((m = re.exec(jsSrc))) {
    const start = jsSrc.indexOf('{', m.index);
    if (start < 0) continue;
    let depth = 0, end = jsSrc.length;
    for (let j = start; j < jsSrc.length; j++) {
      if (jsSrc[j] === '{') depth++;
      else if (jsSrc[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    topLevelKeys(jsSrc.slice(start, end)).forEach((k) => keys.add(k));
  }
  return keys;
}

function membersOf(jsPath) {
  if (!exists(jsPath)) return null;
  if (pageMemberCache.has(jsPath)) return pageMemberCache.get(jsPath);
  const src = readText(jsPath);
  const members = parsePageMembers(src);
  const result = members ? { ...members, keys: collectDataKeys(src, members), src } : null;
  pageMemberCache.set(jsPath, result);
  return result;
}

/* ---- 4.1 事件处理器 ---- */
(function checkHandlers() {
  const check = defCheck('handlers', '事件处理器 bind*/catch* 是否在 Page 中定义');

  const BIND_RE = /\b(?:capture-)?(?:bind|catch|mut-bind)(?::)?([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  wxmlParsed.forEach(({ file, parsed }) => {
    const jsPath = pageJsOf(file);
    const members = membersOf(jsPath);

    let m;
    BIND_RE.lastIndex = 0;
    while ((m = BIND_RE.exec(parsed.clean))) {
      const evt = m[1];
      const handler = (m[2] !== undefined ? m[2] : m[3] || '').trim();
      if (!handler) continue;
      if (handler.includes('{{')) continue; // 动态绑定，静态无法判定
      const loc = parsed.locator(m.index);
      if (!/^[A-Za-z_$][\w$]*$/.test(handler)) continue;
      if (!members) {
        push(check, file, loc.line, 'bind' + evt + '="' + handler + '"：找不到对应的页面 js，无法校验', SEV.CRIT);
      } else if (!members.all.has(handler)) {
        push(check, file, loc.line,
          'bind' + evt + '="' + handler + '"：' + rel(jsPath) + ' 的 Page({}) 里没有定义 ' + handler + '()，点击/输入时不会触发',
          SEV.CRIT, { snippet: 'bind' + evt + '=' + handler });
      }
    }
  });
})();

/* ---- 4.2 类名一致性 ---- */
(function checkClasses() {
  const check = defCheck('classes', 'WXML 类名 ↔ WXSS 定义一致性');

  /**
   * 从 {{...}} 表达式里取「可能成为类名」的字符串字面量。
   * 只认三元表达式的结果分支：a ? 'b' : 'c' → b、c；
   * 条件里的字面量（例：{{filter === 'all' ? 'on' : ''}} 的 all）不是类名，要排除。
   */
  function classLiteralsInExpression(expr) {
    const out = [];
    let depth = 0;
    let buf = '';
    let inResult = false;
    const segments = [];
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[' || ch === '{') { depth++; buf += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { depth--; buf += ch; continue; }
      if (depth === 0 && (ch === '?' || ch === ':')) {
        segments.push({ text: buf, result: inResult });
        buf = '';
        inResult = true;
        continue;
      }
      buf += ch;
    }
    segments.push({ text: buf, result: inResult });

    segments.forEach((seg) => {
      if (!seg.result) return;
      const litRe = /'([^']*)'|"([^"]*)"/g;
      let lm;
      while ((lm = litRe.exec(seg.text))) {
        const v = lm[1] !== undefined ? lm[1] : lm[2];
        v.split(/\s+/).filter(Boolean).forEach((tok) => {
          if (/^[A-Za-z_][\w-]*$/.test(tok)) out.push(tok);
        });
      }
    });
    return out;
  }

  /** wxml 里用到的 class（含 {{a ? 'b' : ''}} 中的字面量） */
  function classesInWxml(src, parsed) {
    const out = []; // {name, line}
    const ATTR_RE = /\b(?:(?:placeholder|hover)-)?class\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(parsed.clean))) {
      const value = m[1] !== undefined ? m[1] : m[2];
      const loc = parsed.locator(m.index);
      // 按 {{ }} 切段
      const parts = value.split(/(\{\{[\s\S]*?\}\})/);
      parts.forEach((part) => {
        if (!part) return;
        if (part.startsWith('{{')) {
          classLiteralsInExpression(part.slice(2, -2)).forEach((tok) => {
            out.push({ name: tok, line: loc.line, dynamic: true });
          });
        } else {
          part.split(/\s+/).filter(Boolean).forEach((tok) => {
            if (/^[A-Za-z_][\w-]*$/.test(tok)) out.push({ name: tok, line: loc.line, dynamic: false });
          });
        }
      });
    }
    return out;
  }

  const usedAll = new Map(); // name -> [{file,line}]
  wxmlParsed.forEach(({ file, src, parsed }) => {
    classesInWxml(src, parsed).forEach((c) => {
      if (!usedAll.has(c.name)) usedAll.set(c.name, []);
      usedAll.get(c.name).push({ file, line: c.line, dynamic: c.dynamic });
    });
  });

  // JS 里动态拼出来的类名（item.cls = 'pos' 这种）
  const dynamicPool = new Set();
  JS_FILES.concat([path.join(ROOT, 'app.js')]).filter(exists).forEach((p) => {
    const src = readText(p);
    const re = /'([^'\\\n]{1,40})'|"([^"\\\n]{1,40})"/g;
    let m;
    while ((m = re.exec(src))) {
      const v = (m[1] !== undefined ? m[1] : m[2]).trim();
      if (/^[A-Za-z_][\w-]*$/.test(v)) dynamicPool.add(v);
    }
  });

  // 用到但没定义
  const usedNames = new Set(usedAll.keys());
  Array.from(usedAll.keys()).sort().forEach((name) => {
    if (definedAny.has(name)) return;
    usedAll.get(name).forEach((occ) => {
      push(check, occ.file, occ.line,
        'class="' + name + '" 在 app.wxss 和本页 wxss 里都没有定义，这条样式完全不生效',
        SEV.MAJOR, { snippet: '.' + name });
    });
  });

  // 定义了但全库没用（web 遗留死代码）
  const dead = [];
  Array.from(definedAny).sort().forEach((name) => {
    if (usedNames.has(name)) return;
    if (dynamicPool.has(name)) return; // 可能由 JS 动态拼出，不算死代码
    // 找出定义它的地方
    const defFiles = [];
    cssParsed.forEach(({ file, parsed }) => {
      parsed.rules.forEach((r) => {
        if (new RegExp('\\.' + name.replace(/[-]/g, '\\-') + '(?![\\w-])').test(r.selector)) {
          const loc = parsed.locator(r.offset);
          defFiles.push({ file, line: loc.line, selector: r.selector });
        }
      });
    });
    if (!defFiles.length) return;
    dead.push({ name, defs: defFiles });
  });

  // 死类名逐条记入（提示级：可直接删除，也可当「还没写页面」的待办）
  dead.forEach((d) => {
    const first = d.defs[0];
    push(check, first.file, first.line,
      'class `.' + d.name + '` 定义了但全库 WXML 都没用到（web demo 遗留，可清理）：' + first.selector,
      SEV.MINOR, { snippet: '.' + d.name });
  });

  check.deadClasses = dead;
})();

/* ---- 4.3 CSS 变量 ---- */
(function checkVars() {
  const check = defCheck('cssvars', 'CSS 变量 var(--x) 是否在 page{} 中定义');

  // 补上 wxml 内联 style 里的 var()
  wxmlParsed.forEach(({ file, src, parsed }) => {
    const re = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(parsed.clean))) {
      const val = m[1] !== undefined ? m[1] : m[2];
      const vre = /var\(\s*(--[A-Za-z0-9_-]+)/g;
      let vm;
      while ((vm = vre.exec(val))) {
        const loc = parsed.locator(m.index);
        cssVarUses.push({ name: vm[1], file, line: loc.line, inWxml: true });
      }
    }
  });

  cssVarUses.forEach((u) => {
    const defs = cssVarDefs.get(u.name);
    if (!defs || !defs.length) {
      if (u.inWxml) return; // wxml 内联由单独一项报
      push(check, u.file, u.line,
        'var(' + u.name + ') 没有定义，该颜色/尺寸会静默失效（属性被丢掉）', SEV.CRIT, { snippet: u.name });
    } else if (!defs.some((d) => d.inPage)) {
      push(check, u.file, u.line,
        'var(' + u.name + ') 定义在非 page{} 选择器里（' + rel(defs[0].file) + ':' + defs[0].line + '），小程序里不一定能继承到',
        SEV.MINOR, { snippet: u.name });
    }
  });

  // 定义未使用
  Array.from(cssVarDefs.keys()).sort().forEach((name) => {
    if (cssVarUses.some((u) => u.name === name)) return;
    const d = cssVarDefs.get(name)[0];
    push(check, d.file, d.line, name + ' 定义了但没有任何地方使用（可清理）', SEV.MINOR, { snippet: name });
  });
})();

/* ---- 4.4 小程序不支持的写法（WXSS） ---- */
function checkUnsupportedCss() {
  const check = defCheck('unsupported-css', 'WXSS 里小程序不支持 / 无效的写法');
  const seen = new Set(); // 去重：file|line|type

  const add = (file, line, msg, severity, key) => {
    const k = file + '|' + line + '|' + key;
    if (seen.has(k)) return;
    seen.add(k);
    push(check, file, line, msg, severity, { key });
  };

  cssParsed.forEach(({ file, parsed }) => {
    parsed.rules.forEach((r) => {
      const loc = parsed.locator(r.offset);
      const line = loc.line;
      const sel = r.selector;
      const inKeyframes = /@keyframes/i.test(r.atRule || '');
      const atPrefix = r.atRule ? '（@' + r.atRule.replace(/^@/, '').split(/\s+/)[0].replace(/:/g, '') + ' 内）' : '';

      /* 元素选择器（@keyframes 里的 from/to/百分比不是元素，跳过） */
      if (!inKeyframes) selectorCompounds(sel).forEach((comp) => {
        const m = comp.match(/^([a-zA-Z][\w-]*)/);
        const selBrief = sel.length > 72 ? sel.slice(0, 72) + '…' : sel;
        if (m) {
          const tag = m[1].toLowerCase();
          if (WEB_ONLY_TAGS.has(tag) && !MINI_TAGS.has(tag)) {
            add(file, line, '元素选择器 `' + tag + '`：小程序没有这个 HTML 标签，整条规则永不命中。规则：' + selBrief + atPrefix,
              SEV.MAJOR, 'tag:' + tag);
          } else if (!MINI_TAGS.has(tag) && !WEB_ONLY_TAGS.has(tag) && tag !== 'page') {
            add(file, line, '元素选择器 `' + tag + '`：不是小程序内置组件，规则不会生效。规则：' + selBrief + atPrefix,
              SEV.MAJOR, 'tag:' + tag);
          }
        }
        if (comp.startsWith('*')) {
          add(file, line, '通配选择器 `*`：小程序不支持（或性能极差），请显式列举' + atPrefix, SEV.MAJOR, 'star');
        }
      });

      /* 属性选择器 */
      if (/\[[^\]]+\]/.test(sel)) {
        add(file, line, '属性选择器 ' + (sel.match(/\[[^\]]+\]/) || [''])[0] + '：小程序 WXSS 不支持' + atPrefix,
          SEV.MAJOR, 'attr');
      }
      /* :has() */
      if (/:has\s*\(/.test(sel)) {
        add(file, line, '`:has()`：小程序 WXSS 不支持（基础库/WebView 版本受限）' + atPrefix, SEV.MAJOR, 'has');
      }
      /* 伪元素 */
      const peRe = /::(-?[A-Za-z][A-Za-z-]*)/g;
      let pm;
      while ((pm = peRe.exec(sel))) {
        const name = pm[1].toLowerCase().replace(/^-/, '');
        if (OK_PSEUDO_ELEMENTS.has(name)) continue;
        if (name.startsWith('webkit-')) {
          add(file, line, '`::-' + name + '`：WebKit 私有伪元素，小程序里通常被忽略（滚动条/表单控件）' + atPrefix,
            SEV.MINOR, 'pe:' + name);
        } else {
          add(file, line, '伪元素 `::' + name + '`：小程序不支持，规则无效' + atPrefix, SEV.MAJOR, 'pe:' + name);
        }
      }
      /* 单冒号伪元素（:before 老写法小程序支持，其他单冒号伪类不在此列） */

      /* 声明层面 */
      const body = r.body;
      if (/\bdvh\b/.test(body)) {
        add(file, line, '`dvh` 单位：需要 iOS 15.4+/Chrome 108+，低版本 WebView 会整条声明失效' + atPrefix,
          SEV.MAJOR, 'dvh');
      }
      if (/position\s*:\s*sticky/.test(body)) {
        add(file, line, '`position:sticky`：小程序（尤其 scroll-view 内）支持不稳定，易退化成 static' + atPrefix,
          SEV.MAJOR, 'sticky');
      }
      if (/backdrop-filter/.test(body)) {
        add(file, line, '`backdrop-filter`：小程序不支持毛玻璃，遮罩会变成纯色或完全不透明' + atPrefix,
          SEV.MAJOR, 'backdrop');
      }
      if (/\benv\s*\(/.test(body)) {
        add(file, line, '`env(safe-area-inset-*)`：小程序支持，但需真机确认（模拟器里恒为 0）' + atPrefix,
          SEV.MINOR, 'env');
      }
      const vhRe = /(?<![\w.])(\d+(?:\.\d+)?)vh\b/g;
      let vm;
      while ((vm = vhRe.exec(body))) {
        if (vm[1] === '100') continue;
        add(file, line, '`' + vm[1] + 'vh`：只有 100vh 在小程序里可靠，其它 vh 建议换 rpx/%' + atPrefix,
          SEV.MINOR, 'vh:' + vm[1]);
      }
    });

    /* at-rule 支持性 */
    parsed.rules.forEach((r) => {
      if (!r.atRule) return;
      const loc = parsed.locator(r.offset);
      const at = r.atRule.toLowerCase();
      if (/^@supports/.test(at)) push(check, file, loc.line, '@supports：小程序 WXSS 不支持，整块被忽略', SEV.MAJOR, { key: 'supports' });
      else if (/^@container/.test(at)) push(check, file, loc.line, '@container：小程序不支持容器查询', SEV.MAJOR, { key: 'container' });
      else if (/^@layer/.test(at)) push(check, file, loc.line, '@layer：小程序不支持级联层', SEV.MAJOR, { key: 'layer' });
    });
  });
}

/* ---- 4.5 WXML 结构 ---- */
(function checkWxml() {
  const check = defCheck('wxml', 'WXML 结构与小程序组件规范');

  wxmlParsed.forEach(({ file, src, parsed }) => {
    const { tags } = parsed;

    /* 非内置组件标签 + 结构栈（text 内嵌块级） */
    const stack = [];
    const BLOCK_TAGS = new Set(('view scroll-view swiper swiper-item image button input textarea picker '
      + 'form video canvas map navigator movable-view movable-area cover-view rich-text progress').split(/\s+/));

    /* 该页 usingComponents 里声明的自定义组件标签（如 sheet-select）是合法的，不算"未知标签" */
    const pageComps = (() => {
      try {
        const jf = file.replace(/\.wxml$/, '.json');
        if (!fs.existsSync(jf)) return new Set();
        const j = JSON.parse(fs.readFileSync(jf, 'utf8').replace(/^\uFEFF/, ''));
        return new Set(Object.keys((j && j.usingComponents) || {}));
      } catch (e) {
        return new Set();
      }
    })();

    tags.forEach((t) => {
      if (t.isClose) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === t.name) { stack.length = i; break; }
        }
        return;
      }

      /* 非内置标签（自定义组件已在 usingComponents 声明则放行） */
      if (!BUILTIN_TAGS.has(t.name) && !pageComps.has(t.name)) {
        push(check, file, t.line,
          '<' + t.name + '> 不是小程序内置组件，编译能过但不会渲染（自定义组件需在 usingComponents 里声明）',
          SEV.MAJOR, { snippet: '<' + t.name + '>' });
      }

      /* 事件绑定样式：bindtap / catchtap 都要在 js 里 */
      /* text 内嵌块级内容 */
      const textFrame = stack.slice().reverse().find((s) => s.name === 'text');
      if (textFrame && BLOCK_TAGS.has(t.name)) {
        push(check, file, t.line,
          '<text> 里嵌套了 <' + t.name + '>：text 只支持嵌套 text，块级内容会显示错位（不换行/溢出）',
          SEV.MAJOR, { snippet: '<' + t.name + '>' });
      }

      /* wx:for 必须有 wx:key */
      if (hasAttr(t, 'wx:for') && !hasAttr(t, 'wx:key')) {
        push(check, file, t.line,
          '<' + t.name + '> 有 wx:for 但缺 wx:key：列表更新时会复用错节点（勾选状态串行）',
          SEV.MAJOR, { snippet: 'wx:for' });
      }

      /* image 缺 mode */
      if (t.name === 'image' && !hasAttr(t, 'mode')) {
        push(check, file, t.line, '<image> 缺 mode：默认 scaleToFill 会拉伸变形', SEV.MINOR, { snippet: 'image' });
      }

      /* input 缺 placeholder（纯文本输入） */
      if (t.name === 'input') {
        const type = (getAttr(t, 'type') || 'text').toLowerCase();
        if (!hasAttr(t, 'placeholder') && (type === 'text' || type === '')) {
          push(check, file, t.line,
            '<input> 是文本输入但没 placeholder：空值时用户看不出这里该填什么', SEV.MINOR, { snippet: 'input' });
        }
      }

      /* hidden 与 wx:if 混用 */
      if (hasAttr(t, 'hidden') && hasAttr(t, 'wx:if')) {
        push(check, file, t.line, '同一个节点同时用了 hidden 和 wx:if：两者语义重叠，容易互相打架', SEV.MINOR, { snippet: 'hidden+wx:if' });
      }

      /* picker 缺 bindchange 基本没意义 */
      if (t.name === 'picker' && !hasAttr(t, 'bindchange') && !hasAttr(t, 'bind:cancel')) {
        push(check, file, t.line, '<picker> 没绑 bindchange：选完不会通知页面（值不会更新）', SEV.MINOR, { snippet: 'picker' });
      }

      if (!t.selfClosing) stack.push(t);
    });

    /* 重复 id */
    const idMap = new Map();
    tags.forEach((t) => {
      const id = getAttr(t, 'id');
      if (!id || id.includes('{{')) return;
      if (!idMap.has(id)) idMap.set(id, []);
      idMap.get(id).push(t);
    });
    idMap.forEach((list, id) => {
      if (list.length < 2) return;
      list.slice(1).forEach((t) => {
        push(check, file, t.line, '重复 id="' + id + '"（同文件第 ' + list[0].line + ' 行已用）：选择器/scroll-into-view 会命中错的那个',
          SEV.MAJOR, { snippet: '#' + id });
      });
    });

    /* 内联 style 里的 var() */
    const styleRe = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let sm;
    while ((sm = styleRe.exec(parsed.clean))) {
      const val = sm[1] !== undefined ? sm[1] : sm[2];
      const vre = /var\(\s*(--[A-Za-z0-9_-]+)/g;
      let vm;
      while ((vm = vre.exec(val))) {
        const loc = parsed.locator(sm.index);
        push(check, file, loc.line,
          '内联 style 里用了 var(' + vm[1] + ')：部分基础库/渲染器下内联变量不生效，建议改成 class',
          SEV.MINOR, { snippet: 'style var' });
      }
    }
  });
})();

/* ---- 4.5b WXML 数据绑定：{{}} 里的根变量是否在 data 里 ---- */
(function checkBindings() {
  const check = defCheck('bindings', 'WXML {{}} 绑定的字段是否存在于 Page.data');
  const LITERALS = new Set(('true false null undefined NaN Infinity this ' +
    'Math JSON Number String Boolean Object Array Date parseInt parseFloat').split(/\s+/));

  wxmlParsed.forEach(({ file, parsed }) => {
    const jsPath = pageJsOf(file);
    const members = membersOf(jsPath);
    if (!members) return;

    /* 循环变量别名（wx:for-item / wx:for-index，含默认 item/index） */
    const aliases = new Set(['item', 'index']);
    parsed.tags.forEach((t) => {
      const fi = getAttr(t, 'wx:for-item');
      const fx = getAttr(t, 'wx:for-index');
      if (fi) aliases.add(fi.trim());
      if (fx) aliases.add(fx.trim());
    });

    const re = /\{\{([\s\S]*?)\}\}/g;
    let m;
    while ((m = re.exec(parsed.clean))) {
      const expr = mask(m[1], { strings: true }); // 表达式里的字符串内容不算标识符
      const idRe = /([A-Za-z_$][\w$]*)/g;
      let im;
      while ((im = idRe.exec(expr))) {
        const name = im[1];
        const before = expr.slice(Math.max(0, im.index - 1), im.index);
        if (before === '.') continue;              // item.xxx 的属性
        if (/^\s*\(/.test(expr.slice(im.index + name.length))) continue; // 函数调用
        if (LITERALS.has(name) || aliases.has(name)) continue;
        if (members.keys.has(name)) continue;
        const loc = parsed.locator(m.index);
        push(check, file, loc.line,
          '{{' + m[1].trim().slice(0, 48) + '}} 里的 `' + name + '` 不是本页 data 的字段，也不是 wx:for 变量：渲染出来会是空/undefined',
          SEV.MINOR, { snippet: name });
        break; // 一个表达式只报一次，避免刷屏
      }
    }
  });
})();

/* ---- 4.5c 页面方法：既没被 WXML 绑定，也没被调用 ---- */
(function checkDeadMethods() {
  const check = defCheck('deadmethods', '页面里定义了但从未被引用的处理函数');
  const LIFECYCLE = new Set(('onLoad onReady onShow onHide onUnload onResize onPageScroll onReachBottom '
    + 'onPullDownRefresh onShareAppMessage onShareTimeline onAddToFavorites onTabItemTap '
    + 'onSaveExitState onThemeChange').split(/\s+/));

  wxmlParsed.forEach(({ file, parsed }) => {
    const jsPath = pageJsOf(file);
    const members = membersOf(jsPath);
    if (!members) return;

    const bound = new Set();
    const re = /\b(?:capture-)?(?:bind|catch|mut-bind)(?::)?[a-zA-Z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(parsed.clean))) {
      const v = (m[1] !== undefined ? m[1] : m[2] || '').trim();
      if (v && !v.includes('{{')) bound.add(v);
    }

    members.funcs.forEach((name) => {
      if (LIFECYCLE.has(name) || bound.has(name)) return;
      // 任何地方出现 .name( 都算被调用（this./that./xxx. 都算）
      if (new RegExp('\\.\\s*' + name.replace(/\$/g, '\\$') + '\\s*\\(').test(members.src)) return;
      // 定位定义行：只允许行内缩进，避免 \s* 跨行吃掉上一行导致行号 -1
      const defRe = new RegExp('(?:^|\\n)[ \\t]*' + name.replace(/\$/g, '\\$') + '\\s*[:(]');
      const dm = defRe.exec(members.src);
      const at = dm ? dm.index + dm[0].indexOf(name) : -1;
      const loc = at >= 0 ? makeLocator(members.src)(at) : { line: 0 };
      push(check, jsPath, loc.line,
        '方法 ' + name + '() 既没有被 WXML 绑定，也没有任何地方调用（死代码，可删）',
        SEV.MINOR, { snippet: name });
    });
  });
})();

/* ---- 4.6 工程完整性 ---- */
(function checkProject() {
  const check = defCheck('project', '工程完整性：页面四件套 / tabBar 图标 / JSON 合法性');

  if (appJsonError) {
    push(check, path.join(ROOT, 'app.json'), 0, 'app.json 解析失败：' + appJsonError, SEV.CRIT);
  } else if (!APP_JSON) {
    push(check, path.join(ROOT, 'app.json'), 0, 'app.json 缺失', SEV.CRIT);
  } else {
    const pages = Array.isArray(APP_JSON.pages) ? APP_JSON.pages : [];
    if (!pages.length) push(check, path.join(ROOT, 'app.json'), 0, 'app.json 的 pages 为空', SEV.CRIT);

    pages.forEach((p) => {
      const base = path.join(ROOT, p);
      if (!exists(base + '.js')) push(check, path.join(ROOT, 'app.json'), 0, '页面 ' + p + ' 缺少 .js（打开即报错）', SEV.CRIT);
      if (!exists(base + '.wxml')) push(check, path.join(ROOT, 'app.json'), 0, '页面 ' + p + ' 缺少 .wxml（打开即报错）', SEV.CRIT);
      if (!exists(base + '.json')) push(check, path.join(ROOT, 'app.json'), 0, '页面 ' + p + ' 缺少 .json（非致命，但建议补齐）', SEV.MINOR);
      if (!exists(base + '.wxss')) push(check, path.join(ROOT, 'app.json'), 0, '页面 ' + p + ' 缺少 .wxss（非致命，页面将无独有样式）', SEV.MINOR);
    });

    /* pages 之外多出来的页面目录 */
    const pageDirs = exists(path.join(ROOT, 'pages'))
      ? fs.readdirSync(path.join(ROOT, 'pages'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : [];
    const declared = new Set(pages.map((p) => p.split('/')[1]));
    pageDirs.forEach((d) => {
      if (!declared.has(d)) {
        push(check, path.join(ROOT, 'pages', d), 0,
          'pages/' + d + ' 目录存在但没写进 app.json 的 pages：该页面无法访问（也不会被打包）', SEV.MINOR);
      }
    });

    /* tabBar */
    const tabBar = APP_JSON.tabBar;
    if (tabBar && Array.isArray(tabBar.list)) {
      if (tabBar.list.length < 2 || tabBar.list.length > 5) {
        push(check, path.join(ROOT, 'app.json'), 0, 'tabBar.list 必须是 2~5 项，当前 ' + tabBar.list.length + ' 项', SEV.CRIT);
      }
      tabBar.list.forEach((item, i) => {
        if (!pages.includes(item.pagePath)) {
          push(check, path.join(ROOT, 'app.json'), 0,
            'tabBar 第 ' + (i + 1) + ' 项的 pagePath（' + item.pagePath + '）不在 pages 列表里', SEV.CRIT);
        }
        ['iconPath', 'selectedIconPath'].forEach((k) => {
          if (!item[k]) return;
          const icon = path.join(ROOT, item[k]);
          if (!exists(icon)) {
            push(check, path.join(ROOT, 'app.json'), 0,
              'tabBar 图标不存在：' + item[k] + '（该 tab 会显示空白或报资源缺失）', SEV.CRIT);
          } else {
            const size = fs.statSync(icon).size;
            if (size > 40 * 1024) {
              push(check, icon, 0, 'tabBar 图标 ' + item[k] + ' 有 ' + Math.round(size / 1024) + 'KB，官方建议 ≤40KB', SEV.MINOR);
            }
          }
        });
      });
    } else if (tabBar) {
      push(check, path.join(ROOT, 'app.json'), 0, 'tabBar 缺少 list 数组', SEV.CRIT);
    }

    /* sitemapLocation */
    if (APP_JSON.sitemapLocation) {
      const sm = path.join(ROOT, APP_JSON.sitemapLocation);
      if (!exists(sm)) push(check, path.join(ROOT, 'app.json'), 0, 'sitemapLocation 指向的 ' + APP_JSON.sitemapLocation + ' 不存在', SEV.MAJOR);
    }
  }

  /* JSON 合法性 */
  const jsonTargets = [
    path.join(ROOT, 'app.json'),
    path.join(ROOT, 'project.config.json'),
    path.join(ROOT, 'project.private.config.json'),
    path.join(ROOT, 'sitemap.json')
  ].concat(JSON_FILES);

  jsonTargets.forEach((p) => {
    if (!exists(p)) {
      if (path.basename(p) === 'project.config.json' || path.basename(p) === 'sitemap.json') {
        push(check, p, 0, rel(p) + ' 缺失，开发者工具会报「项目配置缺失」', SEV.MAJOR);
      }
      return;
    }
    const r = loadJson(p);
    if (!r.ok) {
      const loc = makeLocator(readText(p));
      const m = /position (\d+)/.exec(r.error);
      const line = m ? loc(Number(m[1])).line : 0;
      push(check, p, line, 'JSON 语法错误：' + r.error + '（该文件会被整体忽略）', SEV.CRIT);
    }
  });

  /* 页面 json 里的 usingComponents 是否指向真实文件 */
  JSON_FILES.forEach((p) => {
    const r = loadJson(p);
    if (!r.ok || !r.value || !r.value.usingComponents) return;
    Object.keys(r.value.usingComponents).forEach((tag) => {
      const target = String(r.value.usingComponents[tag] || '');
      if (!target || target.startsWith('plugin://') || target.startsWith('ext://')) return;
      const abs = target.startsWith('/') ? path.join(ROOT, target) : path.resolve(path.dirname(p), target);
      if (!exists(abs + '.js') && !exists(abs + '.wxml') && !exists(abs)) {
        push(check, p, 0, 'usingComponents["' + tag + '"] 指向 ' + target + '，文件不存在', SEV.CRIT);
      }
    });
  });
})();

/* ---- 4.7 补充：运行时风险（启发式） ---- */
(function checkRuntime() {
  const check = defCheck('runtime', 'JS 运行时风险（启发式，需人工确认）');
  check.heuristic = true;

  const KEYWORDS = new Set(('if else for while do return new typeof function const let var class extends super '
    + 'try catch finally throw switch case break continue instanceof in of null true false undefined void '
    + 'delete yield await async this static get set default export import from').split(/\s+/));
  const GLOBALS = new Set(('wx App Page Component Behavior getApp getCurrentPages console require module exports '
    + 'process global setTimeout setInterval clearTimeout clearInterval setImmediate Promise Object Array Math '
    + 'JSON Number String Boolean Date RegExp Error TypeError RangeError parseInt parseFloat isNaN isFinite '
    + 'encodeURIComponent decodeURIComponent Infinity NaN Symbol Map Set WeakMap WeakSet Proxy Reflect '
    + 'Function arguments globalThis').split(/\s+/));

  const targets = JS_FILES.concat([path.join(ROOT, 'app.js')]).filter(exists);

  targets.forEach((p) => {
    const src = readText(p);
    const masked = mask(src, { strings: true });
    const locator = makeLocator(src);

    /* (1) 未声明标识符 */
    const declared = new Set();
    let m;
    const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    while ((m = declRe.exec(masked))) declared.add(m[1]);
    const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = fnRe.exec(masked))) declared.add(m[1]);
    const paramRe = /\bfunction\s*[\w$]*\s*\(([^)]*)\)/g;
    while ((m = paramRe.exec(masked))) {
      m[1].split(',').forEach((s) => {
        const t = s.trim().split(/\s*=\s*/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) declared.add(t);
      });
    }
    const arrowRe = /\(([^()]*)\)\s*=>/g;
    while ((m = arrowRe.exec(masked))) {
      m[1].split(',').forEach((s) => {
        const t = s.trim().split(/\s*=\s*/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) declared.add(t);
      });
    }
    const arrow1Re = /([A-Za-z_$][\w$]*)\s*=>/g;
    while ((m = arrow1Re.exec(masked))) declared.add(m[1]);
    const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
    while ((m = catchRe.exec(masked))) declared.add(m[1]);

    const identRe = /([A-Za-z_$][\w$]*)/g;
    let hitCount = 0;
    while ((m = identRe.exec(masked))) {
      const name = m[1];
      const idx = m.index;
      const before = masked.slice(Math.max(0, idx - 1), idx);
      const after = masked.slice(idx + name.length, idx + name.length + 2);
      if (before === '.') continue;          // 属性访问
      if (/^[\w$]/.test(before)) continue;    // 数字/标识符内部
      if (/^\s*:/.test(after)) continue;      // 对象字面量的 key
      if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
      if (/^[A-Z_]/.test(name) && name === name.toUpperCase()) continue; // 常量占位
      const loc = locator(idx);
      push(check, p, loc.line,
        '引用了未声明的标识符 `' + name + '`（很可能是手误），运行到这一行会抛 ReferenceError',
        SEV.CRIT, { snippet: name });
      if (++hitCount > 20) break;
    }

    /* (2) 对象字面量后直接 .bind()/.call()/.apply()：对象没有这些方法 */
    const objBindRe = /\}\s*\.(bind|call|apply)\s*\(/g;
    while ((m = objBindRe.exec(masked))) {
      const loc = locator(m.index);
      push(check, p, loc.line,
        '对象字面量后直接调用 .' + m[1] + '()：普通对象没有这个方法，会抛 TypeError（想绑 this 请先赋给变量或用箭头函数）',
        SEV.CRIT, { snippet: '.' + m[1] });
    }
  });
})();

/* ---- 4.8 死样式汇总（web 遗留） ---- */
function buildDeadStyleReport() {
  const out = [];
  const usedIds = new Set();
  wxmlParsed.forEach(({ parsed }) => {
    parsed.tags.forEach((t) => {
      const id = getAttr(t, 'id');
      if (id && !id.includes('{{')) usedIds.add(id);
    });
  });

  const idSelectors = []; // {id, file, line, selector}
  cssParsed.forEach(({ file, parsed }) => {
    parsed.rules.forEach((r) => {
      const re = /#(-?[_a-zA-Z][\w-]*)/g;
      let m;
      while ((m = re.exec(r.selector))) {
        const loc = parsed.locator(r.offset);
        idSelectors.push({ id: m[1], file, line: loc.line, selector: r.selector });
      }
    });
  });

  const deadIds = idSelectors.filter((x) => !usedIds.has(x.id));
  return {
    deadIds,
    allIds: idSelectors,
    usedIds: Array.from(usedIds),
    deadClasses: (CHECKS.find((c) => c.id === 'classes') || {}).deadClasses || []
  };
}

/* ---- 4.9 死样式检查项 ---- */
(function checkDeadStyle() {
  const check = defCheck('deadstyle', 'web 遗留死样式（选择器在 WXML 里不存在）');
  const rep = buildDeadStyleReport();
  check.deadStyle = rep;

  const seen = new Set();
  rep.deadIds.forEach((x) => {
    const k = x.file + '|' + x.line + '|#' + x.id;
    if (seen.has(k)) return;
    seen.add(k);
    push(check, x.file, x.line,
      'ID 选择器 #' + x.id + '：所有 WXML 里都没有这个 id，整条规则是死代码（' + x.selector + '）',
      SEV.MINOR, { snippet: '#' + x.id });
  });
})();

/* 把 4.4 的检查放在 4.2/4.3 之后执行（保持报告顺序：先阻断项） */
checkUnsupportedCss();

/* 让 CHECKS 顺序更符合阅读习惯 */
(function reorder() {
  const order = ['project', 'handlers', 'bindings', 'classes', 'cssvars', 'unsupported-css', 'wxml', 'runtime', 'deadmethods', 'deadstyle'];
  CHECKS.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
})();

/* ------------------------------------------------------------------ *
 * 5. 输出
 * ------------------------------------------------------------------ */

function statusOf(check) {
  return check.findings.length ? 'fail' : 'pass';
}

function severityCount(list) {
  const c = { [SEV.CRIT]: 0, [SEV.MAJOR]: 0, [SEV.MINOR]: 0 };
  list.forEach((f) => { if (c[f.severity] !== undefined) c[f.severity]++; });
  return c;
}

function printReport() {
  console.log('');
  console.log(paint('========== 小程序静态扫描 ==========', C.bold));
  console.log(paint('工程：' + ROOT, C.dim));
  console.log(paint('时间：' + new Date().toLocaleString('zh-CN'), C.dim));
  console.log('');

  CHECKS.forEach((check, i) => {
    const ok = !check.findings.length;
    const tag = ok ? paint(' 通过 ', C.green) : paint(' 未通过 ', C.red);
    console.log(paint('[' + (i + 1) + '/' + CHECKS.length + ']', C.cyan) + tag + check.title +
      paint('  (' + check.findings.length + ' 条)', C.dim));
    if (!ok) {
      const shown = check.findings.slice(0, 40);
      shown.forEach((f) => {
        const sev = f.severity === SEV.CRIT ? paint('严重', C.red)
          : f.severity === SEV.MAJOR ? paint('一般', C.yellow) : paint('提示', C.gray);
        console.log('   ' + sev + ' ' + paint(rel(f.file) + ':' + f.line, C.bold) + '  ' + f.message);
      });
      if (check.findings.length > shown.length) {
        console.log(paint('   …还有 ' + (check.findings.length - shown.length) + ' 条，见 JSON 结果', C.dim));
      }
    }
    console.log('');
  });

  const all = findings.slice();
  const c = severityCount(all);
  console.log(paint('========== 汇总 ==========', C.bold));
  console.log('严重 ' + paint(String(c[SEV.CRIT]), c[SEV.CRIT] ? C.red : C.green) +
    '   一般 ' + paint(String(c[SEV.MAJOR]), c[SEV.MAJOR] ? C.yellow : C.green) +
    '   提示 ' + paint(String(c[SEV.MINOR]), C.gray) +
    '   合计 ' + all.length);
  console.log(paint('机器可读结果：' + rel(JSON_OUT), C.dim));
  console.log('');
}

function writeJson() {
  if (!exists(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    projectRoot: ROOT,
    counts: severityCount(findings),
    checks: CHECKS.map((c) => ({
      id: c.id,
      title: c.title,
      status: statusOf(c),
      count: c.findings.length,
      findings: c.findings.map((f) => ({
        severity: f.severity,
        file: rel(f.file),
        line: f.line,
        message: f.message
      }))
    })),
    deadClasses: ((CHECKS.find((c) => c.id === 'classes') || {}).deadClasses || []).map((d) => ({
      name: d.name,
      definedAt: d.defs.map((x) => rel(x.file) + ':' + x.line)
    })),
    deadIdSelectors: ((CHECKS.find((c) => c.id === 'deadstyle') || {}).deadStyle || { deadIds: [] })
      .deadIds.map((x) => ({ id: x.id, file: rel(x.file), line: x.line, selector: x.selector })),
    usedIds: ((CHECKS.find((c) => c.id === 'deadstyle') || {}).deadStyle || {}).usedIds || []
  };
  fs.writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2), 'utf8');
}

/* 调试：打印每个页面的 data 键，便于排查误报
   用法： node miniprogram\_tools\static-audit.js --debug-keys */
if (process.argv.includes('--debug-keys')) {
  wxmlParsed.forEach(({ file }) => {
    const m = membersOf(pageJsOf(file));
    console.log(rel(file) + ' -> ' + (m ? Array.from(m.keys).sort().join(', ') : '找不到页面 js'));
  });
  process.exit(0);
}

try {
  printReport();
  writeJson();
  const c = severityCount(findings);
  process.exitCode = c[SEV.CRIT] > 0 ? 1 : 0;
} catch (e) {
  console.error('[static-audit] 运行失败：', e && e.stack ? e.stack : e);
  process.exitCode = 2;
}
