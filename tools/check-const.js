/**
 * 扫「const 声明后又赋值」——微信开发者工具编译会直接报
 *   Cannot reassign to a variable declared with const
 * 命中后整页 JS 编译失败，控制台还会连带报 "module ... is not defined"。
 *
 * 用法：node tools\check-const.js   （有问题退出码 1）
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['miniprogram/pages', 'miniprogram/utils', 'miniprogram/components', 'miniprogram/config'];

function collect(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (f === 'node_modules' || f === 'shared') continue;
      collect(p, out);
    } else if (f.endsWith('.js')) out.push(p);
  }
}

/** 去掉字符串与注释（保留长度与换行，方便算行号） */
function stripNoise(src) {
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i]; const nx = src[i + 1];
    if (c === '/' && nx === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && nx === '*') {
      i += 2; out += '  ';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === q) { out += ' '; i++; break; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function lineOf(src, pos) { return src.slice(0, pos).split('\n').length; }

const files = [];
ROOTS.forEach(function (r) { collect(r, files); });

let bad = 0;
files.forEach(function (file) {
  const raw = fs.readFileSync(file, 'utf8');
  let clean = stripNoise(raw);

  // 1) 找到所有 const 声明，记下名字与位置，然后把声明本身"抹掉"，避免被当成赋值
  const decls = [];
  clean = clean.replace(/\bconst\s+([A-Za-z_$][\w$]*)\s*=/g, function (m, name, offset) {
    decls.push({ name: name, pos: offset });
    return ' '.repeat(m.length);
  });
  if (!decls.length) return;

  // 2) 其它声明（let/var/同名 const）用来判断变量是否被遮蔽
  const otherDecls = [];
  // 不带 `= ` 也要识别（`let s;` 这种先声明后赋值的写法很常见）
  const re = /\b(let|var|const)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(clean))) otherDecls.push({ name: m[2], pos: m.index });

  decls.forEach(function (d) {
    const assign = new RegExp('(^|[^.\\w$])' + d.name.replace(/\$/g, '\\$') + '\\s*=(?!=)', 'g');
    let a;
    while ((a = assign.exec(clean))) {
      const pos = a.index + a[1].length;
      if (pos <= d.pos) continue;
      const shadowed = otherDecls.some(function (x) { return x.name === d.name && x.pos > d.pos && x.pos < pos; });
      if (shadowed) continue;
      bad++;
      if (bad <= 15) {
        console.log(file + ':' + lineOf(raw, pos) + '  「' + d.name + '」第 ' + lineOf(raw, d.pos) + ' 行是 const，这里又赋值 → 改 let');
        console.log('    ' + String(raw.split('\n')[lineOf(raw, pos) - 1] || '').trim().slice(0, 90));
      }
    }
  });
});

console.log(bad === 0 ? '✅ 没有 const 重复赋值' : '❌ 共 ' + bad + ' 处（只显示前 15 条）');
process.exit(bad === 0 ? 0 : 1);