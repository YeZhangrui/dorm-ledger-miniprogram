/**
 * WXML 标签配对检查。
 *
 * 为什么需要：微信开发者工具的编译会报
 *   [WXML 文件编译错误] ... get tag end without start, near `</`
 * 但本机的 wcsc 校验有时不会拦住（尤其是"删了开标签、留了闭标签"这种），
 * 一直到 IDE 里才炸。这里做一次纯文本的配对检查。
 *
 * 用法：node tools\check-wxml.js   （不平衡时退出码 1）
 */
const fs = require('fs');
const path = require('path');

const VOID_TAGS = new Set(['input', 'image', 'icon', 'progress', 'switch', 'slider', 'textarea', 'import', 'include']);

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
  let src = fs.readFileSync(file, 'utf8');
  // 去掉注释
  src = src.replace(/<!--[\s\S]*?-->/g, '');

  const stack = [];
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[0];
    const name = m[1];
    const selfClose = m[3] === '/';
    if (raw[1] === '/') {
      // 闭标签
      if (!stack.length) {
        bad++;
        console.log(file + ':' + lineOf(src, m.index) + '  多出来的 </' + name + '>（前面没有对应的开标签）');
        continue;
      }
      const top = stack[stack.length - 1];
      if (top.name !== name) {
        bad++;
        console.log(file + ':' + lineOf(src, m.index) + '  标签不匹配：期望 </' + top.name + '>（第 ' + top.line + ' 行开），实际 </' + name + '>');
        continue;
      }
      stack.pop();
    } else if (!selfClose && !VOID_TAGS.has(name)) {
      stack.push({ name: name, line: lineOf(src, m.index) });
    }
  }
  if (stack.length) {
    stack.forEach(function (s) {
      bad++;
      console.log(file + ':' + s.line + '  <' + s.name + '> 没有闭合');
    });
  }
});

function lineOf(src, pos) {
  return src.slice(0, pos).split('\n').length;
}

console.log(bad === 0 ? '✅ 所有 WXML 标签配对正确（共 ' + files.length + ' 个文件）' : '❌ 共 ' + bad + ' 处标签问题');
process.exit(bad === 0 ? 0 : 1);
