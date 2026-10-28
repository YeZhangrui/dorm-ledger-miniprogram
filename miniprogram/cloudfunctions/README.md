# cloudfunctions/ · 寝账云函数（上线版服务端）

「寝室公共开支台账」小程序的微信云开发后端。客户端不再直连数据库，所有读写都通过这 5 个云函数完成；
分摊/结算/小票解析复用 `_shared/finance.js`（与 `miniprogram/utils/finance.js` **逐字节一致**）。

> 目录位置：`miniprogram/cloudfunctions/`，与 `project.config.json` 的 `"cloudfunctionRoot": "cloudfunctions/"` 对应。

## 目录结构

```
cloudfunctions/
├── _shared/                  # 共享模块（不是云函数，不要单独上传部署）
│   ├── finance.js            # 从 miniprogram/utils/finance.js 原样复制，CI 会做哈希一致性校验
│   ├── db.js                 # cloud.init、身份校验、事务封装、错误码、统一返回、建房/房间码
│   └── validate.js           # 入参校验：金额/名单/日期/文案长度/分页游标/房间码
├── login/    index.js + package.json   # whoami、importLocal（本机账本迁移）
├── room/     index.js + package.json   # 建房/加入/退出/改名/解散/成员/档案/换码/我的房间
├── expense/  index.js + package.json   # 记账/改账/软删/结清/反结清/列表/汇总
├── ai/       index.js + package.json   # 小票识图（DeepSeek 多模态）+ 日配额
├── backup/   index.js + package.json + config.json   # 定时备份（只能定时触发，触发器在 config.json）
└── README.md
```

`finance.js` 的一致性校验：

```powershell
(Get-FileHash .\miniprogram\utils\finance.js).Hash -eq (Get-FileHash .\miniprogram\cloudfunctions\_shared\finance.js).Hash
# 必须输出 True；改逻辑请改 miniprogram/utils/finance.js 后再整体复制，别只改一边
```

## 一、部署前必读：`_shared` 怎么进云函数

微信开发者工具上传云函数时**只上传该函数自己的目录**，`../_shared` 不会被带上去。
所以每个 `index.js` 顶部有一个两行加载器：

```js
var SHARED = fs.existsSync(path.join(__dirname, '..', '_shared', 'db.js')) ? '../_shared/' : './shared/';
```

- 仓库/本地调试：走 `../_shared/`（唯一真源，改了立刻生效）；
- 上传部署前：把 `_shared` 复制成每个函数目录里的 `shared/`，走 `./shared/`。

复制命令（在 `cloudfunctions/` 目录执行，改完 `_shared` 记得重新跑一次）：

```powershell
Get-ChildItem -Directory |
  Where-Object { $_.Name -in @('login','room','expense','ai','backup') } |
  ForEach-Object { Copy-Item -Recurse -Force ".\_shared" (Join-Path $_.FullName "shared") }
```

## 二、云开发控制台准备（**索引必须在控制台手动建**）

### 1. 建集合（权限全部设为「仅管理端可读写」，客户端不允许直连）

| 集合 | 说明 |
| --- | --- |
| `rooms` | 房间 |
| `room_members` | 房间成员关系 |
| `expenses` | 账目 |
| `settle_logs` | 结清流水 |
| `usage` | AI 用量（日配额） |

> 权限路径：云开发控制台 → 数据库 → 集合 → 权限设置 → **仅管理端可读写**。
> 客户端只能通过云函数访问，`wx.cloud.database()` 直接读写必须失败。

### 2. 建索引（**手动建，代码里不会自动创建**）

| 集合 | 索引字段 | 类型 | 用途 |
| --- | --- | --- | --- |
| `rooms` | `code` | **唯一** | 房间码唯一 |
| `rooms` | `status` + `updatedAt`(desc) | 普通 | 房间列表 |
| `room_members` | `roomId` + `openid` | **唯一** | 一人一房一条记录、退出后重入复用同一条 |
| `room_members` | `openid` + `status` | 普通 | whoami / 我的房间 |
| `room_members` | `roomId` + `status` + `joinedAt` | 普通 | 成员列表 |
| `expenses` | `roomId` + `clientId` | **唯一** | 记账幂等（同一次记账只落一条） |
| `expenses` | `roomId` + `date`(desc) + `createdAt`(desc) + `_id`(desc) | 普通 | 列表游标分页 |
| `expenses` | `roomId` + `revoked` + `date`(desc) | 普通 | 汇总/备份过滤 |
| `settle_logs` | `expenseId` | 普通 | 查某笔账的结清流水 |
| `settle_logs` | `roomId` + `at`(desc) | 普通 | 房间流水分页 |

> ⚠️ 建唯一索引前先确认库里没有重复数据，否则会建失败。
> ⚠️ `usage` 不需要建索引（`_id` 天生唯一，就是 `<openid>_<yyyyMMdd>`）。

### 3. 环境变量（云函数 → ai → 配置）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_KEY` | **ai 必填** | DeepSeek API Key（`sk-...`）。只存在云函数环境变量里，不下发客户端、不写日志 |
| `DEEPSEEK_MODEL` | 可选 | 默认 `deepseek-flash` |
| `AI_DAILY_LIMIT` | 可选 | 每人每天识图次数，默认 `10` |

未配置 `DEEPSEEK_KEY` 时 `ai.recognize` 直接返回 `INVALID / "AI 未配置"`，不占配额。
这几个变量只需配在 `ai` 函数上；其它函数不读 Key。

### 4. 云函数配置

| 函数 | 超时 | 内存 | 触发方式 |
| --- | --- | --- | --- |
| `login` / `room` / `expense` | 20 秒 | 256MB | 客户端调用 |
| `ai` | **60 秒**（默认 3 秒不够，必须调大） | 256MB | 客户端调用 |
| `backup` | **60 秒** | 256MB | **定时触发器**（客户端调用会被拒绝） |

`backup` 的定时触发器已经写进 `backup/config.json`（上传时开发者工具会带上），也可以到控制台「定时触发器」里手填：

```
0 0 3 * * * *     # 每天 03:00 备份一次（秒 分 时 日 月 星期 年）
```

### 5. 云存储权限

- 云存储整体权限：**仅管理端可读写**（备份文件里是全体用户账目）。
- AI 识图用到的临时目录：`ai-temp/`（客户端上传路径必须落在这个前缀下，详见下文「客户端对接要点」）。

## 三、统一调用约定

```js
// 客户端
wx.cloud.callFunction({
  name: 'expense',
  data: { action: 'add', payload: { /* ... */ } }
})
```

| 情况 | 返回 |
| --- | --- |
| 成功 | `{ ok: true, data: <任意> }` |
| 失败 | `{ ok: false, code: '...', message: '中文提示' }` |

**错误码**

| code | 含义 | 客户端建议 |
| --- | --- | --- |
| `NO_AUTH` | 拿不到 OPENID | 重新登录/重进小程序 |
| `NOT_MEMBER` | 不是该房间成员 | 回到「创建/加入房间」 |
| `ROOM_NOT_FOUND` | 房间不存在或已解散 | 同上 |
| `ROOM_FULL` | 房间满 8 人 | 提示换房间 |
| `INVALID` | 参数不合法（含各种业务校验、权限不足） | 直接 toast `message` |
| `QUOTA` | AI 当日次数用完 / 上游限流 | 提示明天再来或手动记账 |
| `INTERNAL` | 未预期异常 | toast「服务开小差了，请稍后重试」 |

**身份**：一律取 `cloud.getWXContext().OPENID`，**不信任**客户端传的 openid。
除 `login.whoami`（身份解析本身）和 `login.importLocal`（新建房间）外，每个 action 都会先 `assertMember(roomId)`。

**房间作用域**：`roomId` 是可选参数。传了就校验「是我的房间」，不传就落到「我当前所在的房间」——
任何 action 都不会跨房间读写。

**时间约定**：`createdAt` / `updatedAt` / `joinedAt` / `at` 全部是**毫秒时间戳（number）**；
「今天/本月/日配额」按**北京时间（UTC+8）**计算（云函数运行环境是 UTC）。

## 四、数据模型

```js
// rooms
{ _id, code:'ABCDEF', name, ownerOpenid, status:'active'|'closed', memberCount,
  createdAt, updatedAt }

// room_members
{ _id, roomId, openid, name, role:'owner'|'member', status:'active'|'quit',
  joinedAt, pending:false, avatarFileID:'', quitAt? }
//  · pending:true 是「迁移进来的老成员占位」，openid 形如 pending:<roomId>:<i>，
//    同名的人 join 时直接认领这条记录（user.memberCount 不变）
//  · avatarFileID 是本项目在需求字段之外补的一个可选字段（存云存储 fileID）

// expenses
{ _id, roomId, clientId, date:'YYYY-MM-DD', item, category, amount,
  payer, mode:'equal'|'days', participants:[{name,weight}], shares:[{name,weight,share,tail}],
  settled:{name:bool}, settleMeta:{name:{openid,at}},
  source:'nl'|'receipt', receipt:object|null, raw,
  revoked:false, createdBy, updatedBy, createdAt, updatedAt }

// settle_logs
{ _id, roomId, expenseId, from, to, amount, action:'settle'|'undo',
  byOpenid, byName, at }

// usage
{ _id:'<openid>_<yyyyMMdd>', aiCalls, bytes, updatedAt }
```

库存的是「名字」而不是 openid：`payer` / `participants[].name` / `settled` 的 key 都是成员昵称，
所以 `updateProfile` 改昵称会同步改写历史账目（上限 300 笔，超过直接拒绝）。

## 五、actions 一览

### login

| action | 入参 | 出参 | 说明 |
| --- | --- | --- | --- |
| `whoami` | — | `{ openid, room: {id, code, name, role} \| null, profile: {name, avatarFileID} \| null }` | 按 openid 找 active 成员关系；没有房间时 room/profile 为 null |
| `importLocal` | `{ label, members:[name], expenses:[...] }` | `{ code, roomId, imported, skipped }` | 新建房间（当前用户 owner，名字取 `members[0]`），历史账目 `clientId = local_<id>`；最多 500 笔；其它成员建成 pending 占位 |

`importLocal` 的行为细节：账目的 `shares` 服务端重算；小票数据坏了只丢小票、账目照迁；
单条不合法计入 `skipped` 不阻断整体；重复导入会新建房间（客户端迁移成功后请清本机数据）。

### room

| action | 入参 | 出参 |
| --- | --- | --- |
| `create` | `{ name, memberName? , roomId? }` | `{ room }` — `name` 2–16 字；`memberName` 不传时沿用我上一个房间的名字，再不行用「寝室长」 |
| `join` | `{ code, name? , roomId? }` | `{ room, rejoined, claimed }` — 已在房间 → `rejoined:true`；同名认领 pending 位 → `claimed:true` |
| `leave` | `{ roomId? }` | `{ left, roomClosed, memberCount, transferTo }` — 房主退出自动转让给最早加入的成员；没有真人可接手则关房 |
| `rename` | `{ name, roomId? }` | `{ room }` — 仅房主 |
| `dissolve` | `{ roomId? }` | `{ closed, code }` — 仅房主，软删除 `status:'closed'` |
| `members` | `{ roomId? }` | `{ room, me, members:[{name, role, status, joinedAt, isMe, pending}] }`（不含 openid） |
| `updateProfile` | `{ name?, avatarFileID?, roomId? }` | `{ profile:{name, avatarFileID}, renamed:{updated,total}\|null }` — 改名会改写历史账目 |
| `resetCode` | `{ roomId? }` | `{ code, room }` — 仅房主 |
| `summary` | — | `{ rooms:[{id, code, name, role, memberCount, createdAt, updatedAt, expenseCount, total}] }` |

`room` 对象统一为 `{ id, code, name, role, memberCount, status, createdAt, updatedAt }`（不返回 ownerOpenid）。

规则：加入时房间必须 `status:'active'` 且 `memberCount < 8`；房间码 `ABCDEFGHJKMNPQRSTUVWXYZ23456789` 取 6 位，
冲突重试最多 5 次；`leave` 后成员 `status:'quit'`、历史账目姓名不变；退出后重新加入复用同一条成员记录（唯一索引）。

### expense

| action | 入参 | 出参 |
| --- | --- | --- |
| `add` | `{ clientId, date, item, category, amount, payer, mode, participants, source, receipt, raw, roomId? }` | `{ expense, duplicated }` |
| `update` | `{ expenseId, patch:{date?,item?,category?,amount?,payer?,mode?,participants?} }` | `{ expense }` |
| `revoke` | `{ expenseId }` | `{ id, revoked:true, already }` |
| `settle` | `{ expenseId, from, to, amount }` | `{ expenseId, from, to, amount, settled:true, duplicate }` |
| `unsettle` | `{ expenseId, from, to }` | `{ expenseId, from, to, amount, settled:false, duplicate }` |
| `list` | `{ cursor?, limit?=30, month?:'YYYY-MM', filter?:'all'\|'open', roomId? }` | `{ items, nextCursor, hasMore }` |
| `summary` | `{ roomId? }` | `{ month, total, count, perHead, openPairs, openTotal, recent, members }` |

`expense` 对象：

```js
{ id, roomId, clientId, date, item, category, amount, payer, mode, participants, shares,
  settled, settleMeta: { name: { at, byMe } },   // openid 不外泄
  source, receipt, raw, revoked, createdAt, updatedAt, createdByMe }
```

`summary` 口径：

- `total` / `count` / `perHead`：**当月**（北京时间）未删除账目；
- `openPairs` / `openTotal` / `members[].net`：**全部**未删除账目（跨月结转才不会丢账），
  直接调用 `finance.js` 的 `unsettled()` / `balances()`（含两两抵消）；
- `members:[{name, status:'active'|'quit'|'ex', net, paid, owed}]`；
- `recent`：最近 5 笔（整个房间，不限于当月）。

幂等与一致性：

- `add` 先按 `(roomId, clientId)` 查，唯一索引兜底；重复提交返回已有那条（`duplicated:true`），不会重复入账；
- `settle`/`unsettle` 先判当前状态，重复调用不产生重复 `settle_logs`（`duplicate:true`）；
- `settle` 的 `amount` **必须等于该笔账里这个人的份额**（±0.01），客户端要按「一笔账 × 一个人」逐笔结清；
- `update` 改了金额/垫付人/参与人 → 这一笔的 `settled` / `settleMeta` 整体重置（原结清状态作废）；
- `revoke` 是软删除，文档保留可审计。

校验硬约束：`0 < amount <= 1000000` 且最多两位小数；`item` ≤ 40 字；`date` 必须真实存在的 `YYYY-MM-DD`；
`participants` 1–8 人且都是 active 成员；`clientId` ≤ 64 字符。

### ai

| action | 入参 | 出参 |
| --- | --- | --- |
| `recognize` | `{ fileID, mime?, roomId? }` | `{ merchant, date, total, sum, lines:[{name,qty,amount,conf}], warnings, raw, quota:{used, limit} }` |

流程：校验成员 → 日配额（`usage` 原子自增，默认 10 次/人/天，超了 `QUOTA`）→ `cloud.downloadFile`
→ base64 → DeepSeek `https://api.deepseek.com/chat/completions`（`deepseek-flash`、`response_format: json_object`、超时 25s、失败重试 1 次）
→ `finance.js` 的 `extractJsonFromText` + `normalizeAiReceipt` → 删除临时图片 → 返回。

- 失败**不扣**次数（出错回滚 `aiCalls`）；
- 图片 ≤ 6MB，类型按文件头识别（客户端 `mime` 只作兜底）；
- 只删除 `ai-temp/` 前缀下的文件，其它 fileID 一律不删（防止误删用户头像/备份）；
- 运行环境 Node 16 没有全局 `fetch` 时自动退回 `https.request`（Node 18+ 优先 `fetch`）。

### backup

定时触发器调用的入口（`event` 忽略）；也支持控制台「云端测试」手动跑一次。

| 入参 | 出参 |
| --- | --- |
| — | `{ date, uploaded, deleted, ms, collections }` |

- 导出 5 个集合到云存储 `backups/<yyyyMMdd>/<collection>.json`，另写 `_manifest.json`；
- 分页 100 条/批，单集合最多 5000 条 / 8MB，超出标记 `truncated`；
- 保留 14 天：第 15–60 天的目录按「已知文件名」拼 fileID 批量删除（云存储没有列目录 API），单次 `deleteFile` ≤ 50 个；
- 客户端调用（带 OPENID）一律 `NO_AUTH`。

## 六、客户端对接要点（和 Lead 对齐过的约定）

1. **AI 上传路径**：`wx.cloud.uploadFile({ cloudPath: 'ai-temp/' + Date.now() + '.jpg' })`，
   然后 `ai.recognize({ fileID })`。路径不在 `ai-temp/` 下时函数不会删文件（安全考虑），会多留一份图片。
2. **`roomId` 可选**：所有 action 都可以不传，默认作用于「我当前所在的房间」；多房间切换时建议显式传。
3. **`join` 可带名字**：`join({ code, name })`。不传时依次取：我在别的房间用过的名字 → `室友N`。
   迁移房间（pending 成员）里如果已有同名位子，会直接认领，不增加人数。
4. **结清要逐笔**：`settle({ expenseId, from, to, amount })` 一次只结一笔账里的一个人；
   跨笔记账的「两两抵消」用 `expense.summary` 的 `openPairs`（服务端已经用 `finance.js` 抵消过），
   客户端展示净额，落库时按 `openPairs[].items` 里的每一笔分别调用 `settle`。
5. **分页**：`list` 用 `nextCursor`（不要用 offset）；`hasMore=false` 时不要再请求。
6. **金额展示**：服务端返回的都是两位小数的 number，前端用 `finance.js` 的 `fmt()` 格式化即可。
7. **删除**：客户端列表/汇总都只拿 `revoked:false` 的数据，不需要自己过滤。

## 七、安全与隐私

- 集合权限「仅管理端可读写」，客户端无法直连数据库；
- 身份只认 `getWXContext().OPENID`，客户端传 openid 一律忽略；
- 所有 action 先 `assertMember`，不存在跨房间读取；
- 出参不返回其它成员的 openid（`settleMeta` 已脱敏成 `{at, byMe}`，`members` 只有昵称）；
- 日志只打函数名 + action + 简要堆栈，**不打印完整入参**（可能含小票文字），**不打印 Key**；
- AI 图片用完即删，不留存；
- 备份文件在云存储里，权限必须「仅管理端可读写」。

## 八、部署步骤

1. **建集合**：云开发控制台 → 数据库 → 新建 `rooms` / `room_members` / `expenses` / `settle_logs` / `usage`，权限选「仅管理端可读写」。
2. **建索引**：按上面第二节的表格逐条建（**手动**，代码不会自动建；唯一索引先查重）。
3. **配环境变量**：`ai` 函数配置里填 `DEEPSEEK_KEY`（可选 `DEEPSEEK_MODEL` / `AI_DAILY_LIMIT`）。
4. **调超时**：`ai` 和 `backup` 都改成 60 秒。
5. **同步共享模块**：执行第一节的复制命令（每个函数目录下会出现 `shared/`）。
6. **上传部署**：开发者工具 → 右键 `cloudfunctions/login` → 「上传并部署：所有文件」，
   对 `login` / `room` / `expense` / `ai` / `backup` 各做一次（**不要**单独上传 `_shared`，它不是云函数）。
7. **建定时触发器**：`backup` 函数 → 定时触发器 → `0 0 3 * * * *`。
8. **云存储权限**设为「仅管理端可读写」。
9. **验证**：客户端启动 → `login.whoami` 应返回 `{ ok:true, room:null }`；
   先 `room.create` 再记账，确认 `expenses` 有数据、`rooms.updatedAt` 在变；
   最后到 `ai` 函数「云端测试」里传一个 `ai-temp/` 的 fileID，验证识图与删除。

## 九、自检（交付前跑过）

```powershell
# 1) 语法检查（全部通过）
Get-ChildItem -Recurse .\cloudfunctions -Filter *.js | ForEach-Object { node --check $_.FullName }

# 2) finance.js 与小程序端一致（输出 True）
(Get-FileHash .\miniprogram\utils\finance.js).Hash -eq (Get-FileHash .\miniprogram\cloudfunctions\_shared\finance.js).Hash
```

本次交付另用内存假 DB 跑了 74 条冒烟用例（建房/加入/记账/幂等/结清/汇总/改名/退出重入/迁移/配额/备份），全部通过。

## 十、已知限制

- `expense.summary` 单房间最多统计 2000 笔（宿舍场景足够）；超过后只统计最近 2000 笔。
- `updateProfile` 改昵称最多改写 300 笔历史账目，超过会拒绝并提示保留原称呼。
- 备份没有「列目录」API，只能按固定文件名反推 fileID 删除；手工传到 `backups/` 下的其它文件不会被清理。
- `settle_logs` 里保留的是当时的姓名，改昵称不会回写流水（审计口径）。
- 房间解散（`closed`）后成员记录保留但不再出现在 `whoami` / `room.summary` 里。
