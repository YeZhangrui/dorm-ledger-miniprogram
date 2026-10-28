const fs = require('fs');
const path = require('path');
// 收集 api.js 暴露的方法
const apiSrc = fs.readFileSync('miniprogram/utils/api.js', 'utf8');
const groups = {};
const gRe = /^  (\w+): \{([\s\S]*?)^  \},?$/gm;
let g;
while ((g = gRe.exec(apiSrc))) {
  const name = g[1];
  const body = g[2];
  const fns = [];
  const fRe = /^\s{4}(\w+):/gm;
  let f;
  while ((f = fRe.exec(body))) fns.push(f[1]);
  groups[name] = fns;
}
console.log('api.js 暴露：');
Object.keys(groups).forEach(k => console.log('  ' + k + ': ' + groups[k].join(', ')));

// 扫调用
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!/_(tools|preview|audit)|node_modules|shared/.test(f)) walk(p); }
    else if (f.endsWith('.js')) files.push(p);
  }
})('miniprogram');
let bad = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /\bapi\.(\w+)\.(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const [, grp, fn] = m;
    if (grp === 'ApiError' || grp === 'isReady' || grp === 'upload' || grp === 'call') continue;
    if (!groups[grp] || groups[grp].indexOf(fn) < 0) {
      bad++;
      console.log('❌ ' + file + ' 调用了不存在的 api.' + grp + '.' + fn);
    }
  }
}
console.log(bad === 0 ? '✅ 所有 api 调用都有对应方法' : '❌ ' + bad + ' 处缺失');