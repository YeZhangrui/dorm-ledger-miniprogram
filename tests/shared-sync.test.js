'use strict';

/**
 * 两份 finance.js 的同步校验：miniprogram/cloudfunctions/_shared/finance.js 必须与
 * miniprogram/utils/finance.js 逐字节一致。
 *
 * 为什么要卡这个：
 *   - 云端结算（计算谁该付谁、做月报）如果用的是另一份"差不多"的副本，
 *     尾差就会和端上分到不同的人头上，出现"端上显示欠 7 元、云端算出 6.99 元"这种对不上的账；
 *   - 端上这份是从头写的纯逻辑层，云端只是它的搬运，任何"顺手改一行"都应该两边一起改。
 *
 * 云函数副本由另一位成员落地，本用例在文件还不存在时 **skip 而不是 fail**，
 * 这样本地与被阻塞的分支都能跑绿；等副本落地后它自动变成硬校验。
 *
 * 跑法（在 D:\小组作业 下）：node --test tests\
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MP_FILE = path.join(ROOT, 'miniprogram', 'utils', 'finance.js');
// 云函数目录必须在小程序工程根内（project.config.json 的 cloudfunctionRoot = cloudfunctions/）
const CLOUD_FILE = path.join(ROOT, 'miniprogram', 'cloudfunctions', '_shared', 'finance.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function countLines(buf) {
  // 只用于失败时给出人看得懂的定位信息
  return buf.toString('utf8').split('\n').length;
}

test('前提：小程序端 miniprogram/utils/finance.js 存在', function () {
  assert.ok(fs.existsSync(MP_FILE), '找不到 ' + MP_FILE + '，工程结构可能被挪动过');
});

test('同步：云函数副本与小程序端 finance.js 的 sha256 完全一致', function (t) {
  if (!fs.existsSync(CLOUD_FILE)) {
    t.skip('miniprogram/cloudfunctions/_shared/finance.js 还不存在（另一位成员正在落地），跳过哈希校验');
    return;
  }

  const mpBuf = fs.readFileSync(MP_FILE);
  const cloudBuf = fs.readFileSync(CLOUD_FILE);
  const mpHash = sha256(mpBuf);
  const cloudHash = sha256(cloudBuf);

  assert.equal(
    cloudBuf.length,
    mpBuf.length,
    '两份 finance.js 字节数不同：端上 ' + mpBuf.length + 'B / 云端 ' + cloudBuf.length + 'B；' +
      '请直接整文件复制（不要手工改云端那句注释或空行）'
  );
  assert.equal(
    cloudHash,
    mpHash,
    '两份 finance.js 内容不一致（sha256 不同，各 ' + mpBuf.length + 'B）：\n' +
      '  端上 ' + mpHash + '（' + countLines(mpBuf) + ' 行）\n' +
      '  云端 ' + cloudHash + '（' + countLines(cloudBuf) + ' 行）\n' +
      '修法：把 miniprogram/utils/finance.js 原样复制到 miniprogram/cloudfunctions/_shared/finance.js'
  );
});

test('纯净：utils/finance.js 保持纯逻辑层（无 wx.* / require / import / fetch）', function (t) {
  // 防的是有人为了图方便在这里直接调 wx.getStorageSync 或发请求，
  // 一改就再也 require 不进 Node 测试，也会让云端副本没法复用
  const src = fs.readFileSync(MP_FILE, 'utf8');
  const forbidden = [
    { re: /wx\s*\./, name: 'wx.* 调用' },
    { re: /\brequire\s*\(/, name: 'require(...)' },
    { re: /^\s*import\s/m, name: 'ESM import' },
    { re: /\bfetch\s*\(/, name: 'fetch(...)' }
  ];
  forbidden.forEach(function (item) {
    assert.ok(
      !item.re.test(src),
      'utils/finance.js 里出现了 ' + item.name + '，它必须保持纯函数才能在 Node 里单测、才能被云函数复用'
    );
  });

  if (fs.existsSync(CLOUD_FILE)) {
    const cloudSrc = fs.readFileSync(CLOUD_FILE, 'utf8');
    forbidden.forEach(function (item) {
      assert.ok(
        !item.re.test(cloudSrc),
        'miniprogram/cloudfunctions/_shared/finance.js 里出现了 ' + item.name + '（云端副本也必须是纯函数）'
      );
    });
  } else {
    t.diagnostic('云端副本尚未落地，只校验了端上这一份');
  }
});

test('部署副本：各云函数里的 shared/finance.js 也必须与 _shared 一致（防止忘跑准备脚本）', function (t) {
  // 上传云函数时只会带函数自己的目录，所以要先把 _shared 复制成 <fn>/shared。
  // 复制完如果又改了 _shared 而忘了重跑脚本，线上就会跑旧的分摊算法 —— 这里卡住它。
  const funcs = ['login', 'room', 'expense', 'ai', 'backup'];
  const srcBuf = fs.readFileSync(CLOUD_FILE);
  const srcHash = sha256(srcBuf);
  let checked = 0;
  funcs.forEach(function (fn) {
    const copy = path.join(ROOT, 'miniprogram', 'cloudfunctions', fn, 'shared', 'finance.js');
    if (!fs.existsSync(copy)) return; // 还没跑过准备脚本，跳过
    const copyHash = sha256(fs.readFileSync(copy));
    assert.equal(
      copyHash,
      srcHash,
      fn + '/shared/finance.js 与 _shared/finance.js 不一致：' +
        '请重新双击 tools\\prepare-cloudfunctions.cmd 再上传云函数'
    );
    checked++;
  });
  t.diagnostic(checked ? '已校验 ' + checked + ' 个函数目录的 shared 副本' : '尚未生成 shared 副本（上传前请先跑准备脚本）');
});
