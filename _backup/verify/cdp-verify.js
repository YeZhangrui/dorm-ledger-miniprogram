/* 验收脚本：Edge 无头 + CDP（Node 22+ 自带 WebSocket，无需 npm 依赖）
   覆盖：首页数字 / 房间隔离 / 迁移 / 导出导入 / 375px 布局 / 0 error / 0 http(s) 请求
   用法：node _backup/verify/cdp-verify.js
   截图输出：_backup/shots/ */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "../..");
const HTML = path.join(ROOT, "寝室公共开支智能记账与分摊提醒-demo.html");
const SHOTS = path.join(ROOT, "_backup", "shots");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log((ok ? "  PASS " : "  FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < (timeout || 15000)) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(120);
  }
  throw new Error("timeout waiting " + (label || "") + (lastErr ? " :: " + lastErr.message : ""));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve);
      this.ws.addEventListener("error", reject);
      this.ws.addEventListener("message", (ev) => this._onMessage(ev.data));
    });
  }
  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message + " " + JSON.stringify(msg.error.data || "")));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      (this.handlers.get(msg.method) || []).forEach((fn) => { try { fn(msg.params); } catch (e) { /* ignore */ } });
    }
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "qz-edge-"));
  console.log("Edge profile:", profile);

  const edge = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-sync",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    "--window-size=1280,900",
    "about:blank"
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitFor(async () => {
      const r = await fetch("http://127.0.0.1:" + port + "/json/version");
      return r.ok;
    }, 20000, "edge devtools");

    const target = await (await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" })).json();
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;

    const httpRequests = [];
    const consoleErrors = [];
    const exceptions = [];
    cdp.on("Network.requestWillBeSent", (p) => {
      if (/^https?:/i.test(p.request.url)) httpRequests.push(p.request.url);
    });
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") consoleErrors.push(p.args.map((a) => a.value || a.description || a.type).join(" "));
    });
    cdp.on("Runtime.exceptionThrown", (p) => {
      exceptions.push((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text);
    });
    cdp.on("Page.javascriptDialogOpening", (p) => {
      consoleErrors.push("unexpected dialog: " + p.message);
      cdp.send("Page.handleJavaScriptDialog", { accept: false });
    });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Log.enable");

    const ev = async (expr) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      }
      return r.result.value;
    };
    const waitReady = async () => {
      await waitFor(async () => (await ev("document.readyState")) === "complete", 15000, "readyState");
      await sleep(150);
    };
    const navigate = async (url) => {
      await cdp.send("Page.navigate", { url });
      await waitReady();
    };
    const shot = async (file) => {
      const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, "base64"));
      return path.join(SHOTS, file);
    };

    const fileUrl = pathToFileURL(HTML).href;
    await navigate(fileUrl);

    /* ---------- A. 全新浏览器：首页演示数字 ---------- */
    console.log("\n[A] 全新 profile · 首页与房间初始化");
    const heroTotal = await ev("document.getElementById('heroTotal').textContent");
    const heroSub = await ev("document.getElementById('heroSub').textContent");
    const reportVals = await ev("Array.prototype.map.call(document.querySelectorAll('#reportOut .grid2 .stat .v'), function(e){return e.textContent;})");
    const st0 = await ev("(function(){var s=QZ.getState();return {n:s.expenses.length, members:s.members.length, me:s.me, code:QZ.getRoom().code, rooms:QZ.getRooms().length, sum:s.expenses.reduce(function(a,e){return a+e.amount},0)}})()");
    const pill = await ev("document.getElementById('roomPillText').textContent");
    check("首页总额 ¥355.20", heroTotal === "¥355.20", heroTotal);
    check("首页 6 笔 · 人均 ¥88.80", /6 笔/.test(heroSub) && /¥88\.80/.test(heroSub), heroSub);
    check("月报结清 87%", reportVals[3] === "87%", JSON.stringify(reportVals));
    check("月报总额/笔数/人均", reportVals[0] === "¥355.20" && reportVals[2] === "6" && reportVals[1] === "¥88.80", JSON.stringify(reportVals));
    check("演示数据 6 笔 / 合计 355.20", st0.n === 6 && Math.abs(st0.sum - 355.2) < 1e-6, JSON.stringify(st0));
    check("房间码为 6 位且避开 0/O/1/I/l", /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(st0.code), st0.code);
    check("顶部房间 pill 显示当前房间码", pill.indexOf(st0.code) >= 0, pill);
    check("默认只有 1 个房间", st0.rooms === 1, String(st0.rooms));
    const codeA = st0.code;

    /* 175px 先不做，先跑功能 */
    /* ---------- B. 房间隔离 ---------- */
    console.log("\n[B] 房间隔离：A 记一笔 → 新建 B → 互不可见 → 切回 A 还原");
    /* A 里记一笔记号 */
    await ev("document.querySelector('[data-go=\"book\"]').click(); document.getElementById('nlInput').value='房间A记号 7.77 四个人分'; document.getElementById('btnParse').click(); document.getElementById('btnConfirm').click();");
    const aAfterMark = await ev("(function(){var s=QZ.getState();return {n:s.expenses.length, first:s.expenses[0].item, total:document.getElementById('heroTotal').textContent}})()");
    check("A 入账后 7 笔", aAfterMark.n === 7, JSON.stringify(aAfterMark));

    /* 新建房间 B（走界面按钮） */
    await ev("document.getElementById('btnRoom').click();");
    check("房间面板可打开", await ev("document.getElementById('roomMask').classList.contains('on')"));
    await ev("document.getElementById('btnNewRoom').click();");
    const roomB = await ev("QZ.getRoom()");
    check("新建 B 后自动切换、房间码不同", roomB.code !== codeA && /^[A-Z0-9]{6}$/.test(roomB.code), JSON.stringify(roomB));
    check("B 是空账本", roomB.count === 0, String(roomB.count));
    check("B 里看不到 A 的记号", (await ev("JSON.stringify(QZ.getState().expenses)")) === "[]");
    check("B 首页总额 ¥0.00", (await ev("document.getElementById('heroTotal').textContent")) === "¥0.00");

    /* B 里记一笔 */
    await ev("document.getElementById('nlInput').value='房间B记号 3 四个人分'; document.getElementById('btnParse').click(); document.getElementById('btnConfirm').click();");
    const bAfter = await ev("(function(){var s=QZ.getState();return {n:s.expenses.length, item:s.expenses[0].item, total:document.getElementById('heroTotal').textContent}})()");
    check("B 入账后 1 笔 / ¥3.00", bAfter.n === 1 && bAfter.total === "¥3.00", JSON.stringify(bAfter));

    /* 结算逻辑回归：逐组标记已结清 */
    const settleBtns = await ev("document.querySelectorAll('#homeSettle [data-settle]').length");
    check("结算逻辑：B 有 3 组待结清", settleBtns === 3, String(settleBtns));
    for (let i = 0; i < 6; i++) {
      const left = await ev("document.querySelectorAll('#homeSettle [data-settle]').length");
      if (!left) break;
      await ev("document.querySelector('#homeSettle [data-settle]').click()");
    }
    check("逐组结算后 B 已全部结清", (await ev("document.getElementById('unsettledCount').textContent")).indexOf("全部结清") >= 0,
      await ev("document.getElementById('unsettledCount').textContent"));

    /* 切回 A（走房间列表点击） */
    await ev("document.getElementById('btnRoom').click();");
    await ev("(function(){var b=document.querySelector('[data-room=\"" + codeA + "\"]'); b.click();})()");
    const backA = await ev("(function(){var s=QZ.getState();return {code:QZ.getRoom().code, n:s.expenses.length, total:document.getElementById('heroTotal').textContent, hasA:s.expenses.some(function(e){return String(e.raw||'').indexOf('房间A记号')>=0}), hasB:s.expenses.some(function(e){return String(e.raw||'').indexOf('房间B记号')>=0})}})()");
    check("切回 A：房间码还原", backA.code === codeA, backA.code);
    check("切回 A：账目数还原 7 笔", backA.n === 7, String(backA.n));
    check("切回 A：总额还原 355.20 + 7.77 = 362.97", backA.total === "¥362.97", backA.total);
    check("A 有 A 的记号 / 没有 B 的记号", backA.hasA && !backA.hasB, JSON.stringify(backA));
    check("房间目录 2 个房间", (await ev("QZ.getRooms().length")) === 2);

    /* 切回 B 仍只有 1 笔 */
    await ev("QZ.switchRoom('" + roomB.code + "')");
    check("再切到 B 仍是 1 笔", (await ev("QZ.getState().expenses.length")) === 1);

    /* 刷新后房间与账本仍然落在 B */
    await cdp.send("Page.reload");
    await waitReady();
    const persisted = await ev("(function(){var s=QZ.getState();return {code:QZ.getRoom().code, n:s.expenses.length, rooms:QZ.getRooms().length}})()");
    check("刷新后仍停在 B、账目 1 笔（按房间持久化）", persisted.code === roomB.code && persisted.n === 1 && persisted.rooms >= 2, JSON.stringify(persisted));

    /* 成员改名逻辑回归：改名要同步历史账目的垫付人 / 参与人 */
    await ev("document.getElementById('btnMembers').click();");
    await ev("(function(){var ins=document.querySelectorAll('#memberRows input[type=text]'); ins[0].value='陈默默'; ins[0].dispatchEvent(new Event('input')); document.getElementById('btnSaveMembers').click();})()");
    const renamed = await ev("(function(){var s=QZ.getState();return {members:s.members, payer:s.expenses[0].payer, parts:s.expenses[0].participants.map(function(p){return p.name}), settled:Object.keys(s.expenses[0].settled)}})()");
    check("成员改名仍同步历史账目（垫付人 / 参与人 / 结清键）",
      renamed.members[0] === "陈默默" && renamed.payer === "陈默默" && renamed.parts[0] === "陈默默" && renamed.settled.indexOf("陈默默") >= 0,
      JSON.stringify(renamed));

    /* 输入房间码加入 / 切换 + 非法码拦截 */
    await ev("document.getElementById('btnRoom').click(); var i=document.getElementById('roomInput'); i.value='" + codeA + "'; document.getElementById('btnJoinRoom').click();");
    check("输入已有房间码可切换过去", (await ev("QZ.getRoom().code")) === codeA, await ev("QZ.getRoom().code"));
    await ev("var i2=document.getElementById('roomInput'); i2.value='ZZZ'; document.getElementById('btnJoinRoom').click();");
    check("非法房间码不切换、给出提示", (await ev("QZ.getRoom().code")) === codeA && /房间码/.test(await ev("document.getElementById('toast').textContent")),
      await ev("document.getElementById('toast').textContent"));
    await ev("var i3=document.getElementById('roomInput'); i3.value='" + (await ev("QZ.genRoomCode([])")) + "'; document.getElementById('btnJoinRoom').click();");
    const joinedRoom = await ev("QZ.getRoom()");
    check("输入本机没有的房间码会新建空房间", joinedRoom.code !== codeA && joinedRoom.count === 0, JSON.stringify(joinedRoom));

    /* ---------- C. 导出 JSON ---------- */
    console.log("\n[C] 导出 JSON 带房间码");
    await ev("QZ.switchRoom('" + codeA + "')");
    const payload = await ev("QZ.buildExportPayload()");
    check("导出 payload.room = 当前房间码", payload.room === codeA, JSON.stringify({ room: payload.room, codeA }));
    check("导出 payload 含 members/me/expenses", Array.isArray(payload.members) && payload.expenses.length === 7, "n=" + payload.expenses.length);
    const exported = await ev(`(function(){
      var cap={download:"",blob:null};
      var oc=URL.createObjectURL, ok=HTMLAnchorElement.prototype.click;
      URL.createObjectURL=function(b){cap.blob=b;return "blob:verify";};
      HTMLAnchorElement.prototype.click=function(){cap.download=this.download;};
      QZ.exportRoomJson();
      URL.createObjectURL=oc; HTMLAnchorElement.prototype.click=ok;
      return cap.blob.text().then(function(t){ return {json:t, name:cap.download}; });
    })()`);
    let expJson = null;
    try { expJson = JSON.parse(exported.json); } catch (e) { /* ignore */ }
    check("真正触发的导出文件名为 .json 且带房间码", /寝账-房间[A-Z0-9]{6}-\d{8}\.json/.test(exported.name), exported.name);
    check("导出文件内容含房间码字段", !!expJson && expJson.room === codeA && expJson.expenses.length === 7, String(exported.json.length) + " chars");

    /* ---------- D. 导入 JSON ---------- */
    console.log("\n[D] 导入 JSON：默认新房间 / 覆盖需确认");
    const importObj = {
      app: "寝账 demo", schema: 4, room: codeA, roomLabel: "默认房间",
      members: ["陈默", "李昊", "王雨", "赵小满"], me: "李昊",
      expenses: [
        { id: "i1", date: "2026-10-01", item: "导入测试甲", category: "饮用水", amount: 10, payer: "李昊", participants: [{ name: "陈默" }, { name: "李昊" }, { name: "王雨" }, { name: "赵小满" }], settled: {} },
        { id: "i2", date: "2026-10-02", item: "导入测试乙", category: "电费", amount: 20, payer: "陈默", participants: [{ name: "陈默" }, { name: "李昊" }], settled: {} },
        { id: "bad", amount: -5, participants: [] }
      ]
    };
    await ev("QZ.setImportDraft(" + JSON.stringify(importObj) + ")");
    const norm = await ev("QZ.getState().importDraft");
    check("导入校验：跳过坏记录并保留 2 条", norm.expenses.length === 2 && norm.skipped === 1, JSON.stringify({ n: norm.expenses.length, skipped: norm.skipped }));
    await ev("QZ.applyImport('new')");
    const impRoom = await ev("QZ.getRoom()");
    check("导入默认落到新房间（不是 A/B）", impRoom.code !== codeA && impRoom.code !== roomB.code && impRoom.count === 2, JSON.stringify(impRoom));
    check("导入房间总额 ¥30.00", (await ev("document.getElementById('heroTotal').textContent")) === "¥30.00");
    check("A 房间仍是 7 笔（没被覆盖）", (await ev("QZ.getRooms().length")) >= 3);
    await ev("QZ.switchRoom('" + codeA + "')");
    check("回到 A 仍是 7 笔", (await ev("QZ.getState().expenses.length")) === 7);

    /* 覆盖：confirm 取消时不动 */
    await ev("QZ.switchRoom('" + impRoom.code + "')");
    await ev("window.__origConfirm = window.confirm; window.confirm = function(){ return false; };");
    await ev("QZ.setImportDraft(" + JSON.stringify({ room: codeA, members: ["陈默", "李昊"], me: "陈默", expenses: [{ id: "x", date: "2026-10-03", item: "覆盖测试", amount: 99, payer: "陈默", participants: [{ name: "陈默" }, { name: "李昊" }] }] }) + ")");
    await ev("QZ.applyImport('overwrite')");
    check("覆盖取消：账目数不变（2 笔）", (await ev("QZ.getState().expenses.length")) === 2);
    /* 覆盖：confirm 确认后生效 */
    await ev("window.confirm = function(){ return true; };");
    await ev("QZ.applyImport('overwrite')");
    const ov = await ev("(function(){var s=QZ.getState();return {n:s.expenses.length, item:s.expenses[0].item, members:s.members.length}})()");
    check("覆盖确认后：账本换成 1 笔", ov.n === 1 && ov.item === "覆盖测试", JSON.stringify(ov));
    await ev("window.confirm = window.__origConfirm;");

    /* ---------- E. 375px 布局截图 ---------- */
    console.log("\n[E] 375px 布局");
    await ev("QZ.switchRoom('" + codeA + "')");
    await ev("document.getElementById('btnCloseRoom').click(); document.querySelector('[data-go=\"home\"]').click(); document.getElementById('content').scrollTop = 0;");
    await sleep(2500); /* 等 toast 淡出，避免挡截图 */
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const homeLayout = await ev("(function(){var d=document.documentElement;return {sw:d.scrollWidth, cw:d.clientWidth, iw:window.innerWidth, bodySW:document.body.scrollWidth, brandR:document.querySelector('.brand-row').getBoundingClientRect().right, pill:(function(){var p=document.getElementById('btnRoom').getBoundingClientRect();return {t:p.top,b:p.bottom,w:p.width}})(), wide:(function(){var bad=[];document.querySelectorAll('.topbar *, .content *').forEach(function(el){var r=el.getBoundingClientRect();if(r.width>0&&r.right>window.innerWidth+1)bad.push(el.className||el.tagName);});return bad.slice(0,5);})()}})()");
    check("375px 无横向滚动", homeLayout.sw <= homeLayout.cw + 1 && homeLayout.bodySW <= homeLayout.cw + 1, JSON.stringify(homeLayout));
    check("375px 头部元素不越界", homeLayout.brandR <= 376 && homeLayout.wide.length === 0, JSON.stringify(homeLayout.wide));
    check("375px 房间 pill 在头部可见", homeLayout.pill.w > 40 && homeLayout.pill.b > 0, JSON.stringify(homeLayout.pill));
    await shot("375-home.png");
    await ev("document.getElementById('btnRoom').click();");
    await sleep(250);
    const sheetLayout = await ev("(function(){var s=document.querySelector('#roomMask .sheet');var r=s.getBoundingClientRect();return {right:r.right,left:r.left,width:r.width,sw:s.scrollWidth,cw:s.clientWidth,vw:window.innerWidth,codeSW:document.querySelector('.room-code').scrollWidth,codeCW:document.querySelector('.room-code').clientWidth}})()");
    check("375px 房间面板不溢出", sheetLayout.right <= 376 && sheetLayout.sw <= sheetLayout.cw + 1 && sheetLayout.codeSW <= sheetLayout.codeCW + 1, JSON.stringify(sheetLayout));
    await shot("375-room-sheet.png");
    await ev("document.getElementById('btnCopyRoom').click();");
    await sleep(250);
    check("复制房间码按钮不抛异常", exceptions.length === 0, JSON.stringify(exceptions.slice(0, 2)));
    await ev("(function(){var s=document.querySelector('#roomMask .sheet'); s.scrollTop = s.scrollHeight;})()");
    await sleep(250);
    await shot("375-room-sheet-bottom.png");
    /* 打开小票 / 提醒 / 明细各页截一张，确认不塌 */
    await ev("document.getElementById('btnCloseRoom').click(); document.querySelector('[data-go=\"list\"]').click();");
    await sleep(200);
    const listLayout = await ev("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1");
    check("375px 明细页无横向滚动", listLayout);
    await shot("375-list.png");
    await ev("document.querySelector('[data-go=\"home\"]').click();");

    /* 1280 桌面截图 */
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await sleep(250);
    await shot("desktop-home.png");

    /* ---------- F. 旧数据迁移（v3 与 v1） ---------- */    console.log("\n[F] 旧数据迁移：账目数不变、只搬一次");
    const legacyKey = "dorm-ledger-demo-v3";
    const legacyData = {
      v: 3, members: ["张三", "李四", "王五", "赵六"], me: "李四",
      expenses: [
        { id: "L1", date: "2026-09-01", item: "旧网费", category: "网费", amount: 120, payer: "李四", mode: "equal", participants: [{ name: "张三" }, { name: "李四", weight: 2 }], settled: { "李四": true }, source: "nl", raw: "旧数据" },
        { id: "L2", date: "2026-09-02", item: "旧水费", category: "饮用水", amount: 36.6, payer: "张三", mode: "equal", participants: [{ name: "张三" }, { name: "李四" }, { name: "王五" }], settled: {}, source: "nl", raw: "旧数据" },
        { id: "L3", date: "2026-09-03", item: "旧电费", category: "电费", amount: 86.4, payer: "王五", mode: "equal", participants: [{ name: "张三" }, { name: "李四" }, { name: "王五" }, { name: "赵六" }], settled: {}, source: "receipt", raw: "旧数据" }
      ]
    };
    await ev("localStorage.clear(); localStorage.setItem('" + legacyKey + "', " + JSON.stringify(JSON.stringify(legacyData)) + ");");
    await cdp.send("Page.reload");
    await waitReady();
    const mig = await ev("(function(){var s=QZ.getState();return {code:QZ.getRoom().code, n:s.expenses.length, members:s.members, me:s.me, first:s.expenses[0].item, flag:localStorage.getItem('qinzhang_migrated_v1'), rooms:QZ.getRooms().length, total:document.getElementById('heroTotal').textContent, legacyLeft:!!localStorage.getItem('dorm-ledger-demo-v3'), roomRaw:!!localStorage.getItem('qinzhang_room_'+QZ.getRoom().code)}})()");
    check("迁移：账目数 3 条不变", mig.n === 3, JSON.stringify(mig));
    check("迁移：成员表 4 人 + 记账人保留", mig.members.length === 4 && mig.me === "李四", JSON.stringify({ m: mig.members, me: mig.me }));
    check("迁移：落到本机唯一房间、生成房间 key", mig.rooms === 1 && mig.roomRaw, JSON.stringify(mig));
    check("迁移：标记已写、旧 key 不删除（可回滚）", mig.flag === "1" && mig.legacyLeft, JSON.stringify({ flag: mig.flag, legacyLeft: mig.legacyLeft }));
    await cdp.send("Page.reload");
    await waitReady();
    const mig2 = await ev("(function(){var s=QZ.getState();return {n:s.expenses.length, rooms:QZ.getRooms().length, code:QZ.getRoom().code}})()");
    check("迁移幂等：二次启动仍是 3 条 / 1 个房间", mig2.n === 3 && mig2.rooms === 1 && mig2.code === mig.code, JSON.stringify(mig2));

    /* v1 纯数组迁移 */
    await ev("localStorage.clear(); localStorage.setItem('dorm-ledger-demo-v1', JSON.stringify([{id:'v1a',date:'2026-08-01',item:'v1 账目',category:'食品',amount:9.9,payer:'陈默',participants:[{name:'陈默'},{name:'李昊'}]}]));");
    await cdp.send("Page.reload");
    await waitReady();
    const migV1 = await ev("(function(){var s=QZ.getState();return {n:s.expenses.length, code:QZ.getRoom().code, item:s.expenses[0].item}})()");
    check("v1 数组数据也能迁移（1 条）", migV1.n === 1 && migV1.item === "v1 账目", JSON.stringify(migV1));

    /* ---------- G. 控制台 / 网络 ---------- */
    console.log("\n[G] 控制台与网络");
    check("0 个 http(s) 请求", httpRequests.length === 0, JSON.stringify(httpRequests.slice(0, 5)));
    check("0 个未捕获异常", exceptions.length === 0, JSON.stringify(exceptions.slice(0, 3)));
    check("0 条 console.error", consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));

    /* ---------- H. 干净 profile 的最终截图（首页仍是 355.20） ---------- */
    console.log("\n[H] 干净状态截图");
    await ev("localStorage.clear()");
    await cdp.send("Page.reload");
    await waitReady();
    const fresh = await ev("(function(){var s=QZ.getState();return {total:document.getElementById('heroTotal').textContent, sub:document.getElementById('heroSub').textContent, n:s.expenses.length, code:QZ.getRoom().code, rooms:QZ.getRooms().length}})()");
    check("清空后重新起一份干净账本：355.20 / 6 笔", fresh.total === "¥355.20" && fresh.n === 6 && fresh.rooms === 1, JSON.stringify(fresh));
    await ev("document.getElementById('content').scrollTop = 0;");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    await shot("375-home-fresh.png");
    /* 真机首次进入（头部默认收起）也截一张：确认房间 pill 仍在、不塌 */
    await ev("localStorage.removeItem('dorm-hero-compact-v1')");
    await cdp.send("Page.reload");
    await waitReady();
    await sleep(300);
    const compact = await ev("(function(){var d=document.documentElement;return {sw:d.scrollWidth,cw:d.clientWidth,min:document.querySelector('.topbar').classList.contains('min'),pillW:document.getElementById('btnRoom').getBoundingClientRect().width,mini:document.getElementById('heroMini').textContent}})()");
    check("375px 头部收起态不塌且房间 pill 可见", compact.sw <= compact.cw + 1 && compact.pillW > 40 && /355\.20/.test(compact.mini), JSON.stringify(compact));
    await shot("375-home-compact.png");
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await sleep(300);
    await shot("desktop-home.png");

    /* ---------- 汇总 ---------- */
    const failed = results.filter((r) => !r.ok);
    console.log("\n========================================");
    console.log("总计 " + results.length + " 项，通过 " + (results.length - failed.length) + "，失败 " + failed.length);
    console.log("截图目录：" + SHOTS);
    if (failed.length) {
      failed.forEach((f) => console.log("FAILED: " + f.name + " :: " + f.detail));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("VERIFY CRASH:", err && err.stack || err);
    process.exitCode = 2;
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { edge.kill(); } catch (e) { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
})();
