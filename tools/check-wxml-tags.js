/**
 * 扫 WXML 里"自闭合斜杠后面还跟着属性"的写法。
 *
 * 这类错误微信开发者工具会直接报：
 *   Unexpected character ``
 *   Compile .wxml 文件错误: unexpected character
 * 但本机 wcsc 有时拦不住，所以单独查一遍：
 *   <textarea ... / show-confirm-bar="{{false}}">   ← 非法（/ 后面又跟属性）
 *   <textarea ... show-confirm-bar="{{false}}" />   ← 合法
 *
 * 用法：node tools\check-wxml-tags.js   （有问题退出码 1）
 */
const fs = require('fs');
const path = require('path');

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!/_(tools|preview|audit)|node_modules/.test(f)) walk(p); }
    else if (f.endsWith('.wxml')) files.push(p);
  }
})('miniprogram');

let bad = 0;
files.forEach(function (file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach(function (line, i) {
    // 只要出现 `/"` 后面还跟着 `名字=`，就是斜杠插错位置
    if (/\/\s+[A-Za-z_:@-][\w:-]*\s*=\s*["']/.test(line)) {
      bad++;
      console.log(file + ':' + (i + 1) + '  自闭合斜杠后还有属性：' + line.trim().slice(0, 100));
    }
  });
});

console.log(bad === 0 ? '✅ WXML 标签内属性顺序正常（' + files.length + ' 个文件）' : '❌ 共 ' + bad + ' 处');
process.exit(bad === 0 ? 0 : 1);
