/* 只读验证：把 _build/app.js 载入 VM（DOM/localStorage 用桩件），
   用重制版同一套 18 条语句 + 4 组分摊算例跑旧 demo 的 parseExpense / computeShares。
   不修改任何源文件。用法：node _backup/verify/parser-test.js [app.js 路径] */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const APP = process.argv[2] || path.resolve(__dirname, "../../_build/app.js");

function makeEl(id) {
  const el = {
    id, textContent: "", innerHTML: "", value: "", checked: false, disabled: false,
    hidden: true, open: false, selectedIndex: 0, options: [], dataset: {},
    style: {}, files: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return makeEl(id + ":sel"); },
    querySelectorAll() { return []; },
    appendChild() {}, removeChild() {}, focus() {}, select() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    closest() { return null; }, scrollIntoView() {}, dispatchEvent() {}, click() {}
  };
  return el;
}
const els = new Map();
function byId(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); }

const store = new Map();
const localStorage = {
  getItem(k) { return store.has(String(k)) ? store.get(String(k)) : null; },
  setItem(k, v) { store.set(String(k), String(v)); },
  removeItem(k) { store.delete(String(k)); },
  clear() { store.clear(); },
  key(i) { return Array.from(store.keys())[i] || null; },
  get length() { return store.size; }
};

const document = {
  getElementById: byId,
  querySelector(sel) { return byId("q:" + sel); },
  querySelectorAll() { return []; },
  addEventListener() {},
  createElement(tag) { return makeEl("new:" + tag); },
  body: makeEl("body"),
  execCommand() { return true; }
};
const sandbox = {
  document, localStorage, console,
  navigator: { clipboard: null, userAgent: "node" },
  window: { innerWidth: 1440, addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  setTimeout, clearTimeout, fetch: function () { throw new Error("no network"); },
  URL: { createObjectURL() { return "blob:x"; }, revokeObjectURL() {} },
  Blob: function () {},
  FileReader: function () {},
  performance: { now: () => Date.now() },
  Event: function () {}
};
sandbox.globalThis = sandbox;
sandbox.window = Object.assign(sandbox, sandbox.window); // window 指向 sandbox 本身，保留 innerWidth
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(APP, "utf8"), sandbox, { filename: APP });

const { state, parseExpense, computeShares, fmt } = sandbox;

const DEMO_MEMBERS = ["陈默", "李昊", "王雨", "赵小满"];
const DEMO_ME = "李昊";

/* 与重制版 TEST_SENTENCES 完全一致；parts=null 表示不计参与人 */
const TEST_SENTENCES = [
  { text: "今天买水 12.4 四个人分", amount: 12.4, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "我垫了网费 120，全寝室 AA", amount: 120, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "电费 86 块 4，平摊", amount: 86.4, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "垃圾袋和洗洁精 19 块 8，四个人分", amount: 19.8, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "李昊买了零食 45，我们四个人分", amount: 45, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "空调电费我和老王分，一共 60", amount: 60, parts: ["李昊", "王雨"], payer: "李昊" },
  { text: "桶装水 24，四个人", amount: 24, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "维修微波炉花了 60，全寝室", amount: 60, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "这个月网费 120，陈默先付的", amount: 120, parts: DEMO_MEMBERS, payer: "陈默" },
  { text: "我买了纸巾 30 块，三个人分（赵小满回家住了）", amount: 30, parts: ["陈默", "李昊", "王雨"], payer: "李昊" },
  { text: "电费 100 块，我出 40，剩下的你们仨分", amount: 100, parts: null, payer: "李昊" },
  { text: "公共零食 45，除了我之外的三个人分", amount: 45, parts: ["陈默", "王雨", "赵小满"], payer: "李昊" },
  { text: "水费 36，4 人均摊", amount: 36, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "我垫了 55 块的电费，四个人分", amount: 55, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "洗衣液 29.9，平摊给四个人", amount: 29.9, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "这周买菜 88 块，四个人分", amount: 88, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "路由器 159，四个人分", amount: 159, parts: DEMO_MEMBERS, payer: "李昊" },
  { text: "我付了 40 块垃圾袋和纸巾，四个人分", amount: 40, parts: DEMO_MEMBERS, payer: "李昊" }
];

function sameSet(a, b) {
  const x = a.slice().sort().join("|"), y = b.slice().sort().join("|");
  return x === y;
}

state.members = DEMO_MEMBERS.slice();
state.me = DEMO_ME;
state.expenses = [];

let amountPass = 0, payerPass = 0, partsPass = 0, partsTotal = 0;
const rows = TEST_SENTENCES.map((tc, i) => {
  let r;
  try { r = parseExpense(tc.text); } catch (e) { r = { amount: NaN, payer: "!", parts: [], err: String(e) }; }
  const amountOk = Math.abs(Number(r.amount) - tc.amount) < 0.005;
  const payerOk = r.payer === tc.payer;
  const partsOk = tc.parts ? sameSet(r.parts, tc.parts) : null;
  if (amountOk) amountPass++;
  if (payerOk) payerPass++;
  if (partsOk !== null) { partsTotal++; if (partsOk) partsPass++; }
  return { no: i + 1, text: tc.text, got: { amount: r.amount, payer: r.payer, parts: r.parts, err: r.err }, exp: tc, amountOk, payerOk, partsOk };
});

/* 4 组算例：用旧 demo 的 computeShares（返回 share 而非 cents） */
const cases = [
  { name: "12.40 / 3 人（除不尽）", amount: 12.4, parts: [{ name: "陈默", weight: 1 }, { name: "李昊", weight: 1 }, { name: "王雨", weight: 1 }] },
  { name: "36.60 / 4 人", amount: 36.6, parts: [{ name: "陈默", weight: 1 }, { name: "李昊", weight: 1 }, { name: "王雨", weight: 1 }, { name: "赵小满", weight: 1 }] },
  { name: "100.00 按 30/20/10 天", amount: 100, parts: [{ name: "陈默", weight: 30 }, { name: "李昊", weight: 20 }, { name: "王雨", weight: 10 }] },
  { name: "45.00 仅 3 人参与", amount: 45, parts: [{ name: "陈默", weight: 1 }, { name: "王雨", weight: 1 }, { name: "赵小满", weight: 1 }] }
];
let casePass = 0;
const caseRows = cases.map((c) => {
  const shares = computeShares(c.amount, c.parts);
  const cents = (n) => Math.round(Number(n) * 100);
  const got = shares.reduce((s, x) => s + cents(x.share), 0);
  const total = cents(c.amount);
  const ok = got === total;
  if (ok) casePass++;
  return { name: c.name, ok, totalCents: total, gotCents: got, shares: shares.map((s) => s.name + " " + s.share.toFixed(2) + (s.tail ? "*" : "")) };
});

console.log("APP:", APP);
rows.forEach((r) => {
  const tag = [r.amountOk ? "金额✓" : "金额✗", r.payerOk ? "垫付✓" : "垫付✗", r.partsOk === null ? "参与-（不计分）" : (r.partsOk ? "参与✓" : "参与✗")].join(" ");
  if (!(r.amountOk && r.payerOk && (r.partsOk !== false))) {
    console.log("FAIL #" + r.no, tag, "|", r.text);
    console.log("   得到:", JSON.stringify(r.got), "\n   期望:", JSON.stringify({ amount: r.exp.amount, payer: r.exp.payer, parts: r.exp.parts }));
  }
});
console.log("---");
console.log("金额 " + amountPass + "/" + rows.length + " · 参与人 " + partsPass + "/" + partsTotal + " · 垫付人 " + payerPass + "/" + rows.length);
console.log("算例：");
caseRows.forEach((c) => console.log("  " + (c.ok ? "✓" : "✗") + " " + c.name + " 合计 " + c.gotCents + "/" + c.totalCents + " :: " + c.shares.join(" | ")));
console.log("算例 " + casePass + "/" + caseRows.length);
process.exit(amountPass === 18 && partsPass === 17 && payerPass === 18 && casePass === 4 ? 0 : 1);
