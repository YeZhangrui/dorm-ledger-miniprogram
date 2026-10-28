const fs = require('fs');
const path = require('path');

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!/_(tools|preview|audit)|node_modules|cloudfunctions/.test(f)) walk(p); }
    else if (/\.(wxml|js|json)$/.test(f)) files.push(p);
  }
})('miniprogram');

const risky = [
  { re: /config\/env\.js|云环境 ID|env\.js/, why: '面向开发者的配置说明' },
  { re: /云函数|Key 只存在|代理调用|api\.deepseek|sk-/, why: '技术实现词/密钥相关' },
  { re: /演示数据|清空账目|测试数据|demo/i, why: '开发/演示入口' },
  { re: /TODO|FIXME|lorem/i, why: '未完成标记' },
  { re: /支付|转账|借贷|理财|收益|投资/, why: '金融类敏感词（需确认是否否定表述）' }
];

let hits = 0;
files.forEach(function (file) {
  const src = fs.readFileSync(file, 'utf8');
  risky.forEach(function (r) {
    const lines = src.split('\n');
    lines.forEach(function (line, i) {
      if (r.re.test(line)) {
        hits++;
        console.log(file + ':' + (i + 1) + '  [' + r.why + ']  ' + line.trim().slice(0, 80));
      }
    });
  });
});
console.log(hits ? '\n共 ' + hits + ' 处需要人工判断' : '✅ 没有可疑文案');