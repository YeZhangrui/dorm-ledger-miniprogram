'use strict';

/**
 * `node --test tests\` 的入口兼容层。
 *
 * 为什么需要这个文件：
 *   Node 20 / 22 收到目录参数时会自己递归找 *.test.js；
 *   但本机 Node 24.19.0（Windows）把目录当成"模块入口"直接加载，
 *   没有 tests/index.js 时会报 `Cannot find module 'D:\...\tests'`（实测）。
 *   有了这个入口，`node --test tests\` 与 `node --test tests\**\*.test.js` 都能跑，
 *   而且 Node 20/22 递归目录时会自动忽略本文件（名字不匹配 test 文件规则），不会重复执行。
 *
 * 维护约定：新增用例只要放进 tests\*.test.js 即可，不用改这里。
 */

const fs = require('node:fs');
const path = require('node:path');

fs.readdirSync(__dirname)
  .filter(function (f) { return /\.test\.js$/.test(f); })
  .sort()
  .forEach(function (f) { require(path.join(__dirname, f)); });
