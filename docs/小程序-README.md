# 寝室公共开支台账 · 微信小程序版

由 **`寝室公共开支智能记账与分摊提醒-demo.html`（当前版本：2026-10-20，3673 行，含房间码与 UI 重构）** 移植的原生小程序工程。

- 工程目录：`D:\小组作业\miniprogram`　AppID：开发者工具打开时会写回 `project.config.json`（当前 `wxbea0c9fc727ddce0`）；想用「无 AppID」就把 appid 改成 `touristappid`
- 页面：首页 / 记账 / 小票 / 明细 / 提醒·月报（tabBar 五个）+ 成员设置 + 房间码
- 样式：`app.wxss` 由 demo 的 `<style>` **机械翻译**而来（px→rpx ×2、`:root`→`page`、去掉手机外框与网页导航），所以视觉与 demo 同源

---

## 一、和 demo 的功能对照（含 10-20 新增的房间码）

| demo（当前版） | 小程序 |
|---|---|
| 顶部深绿封面 + 收起按钮（`⌃/⌄`，手机默认收起，记忆选择） | 同（首页自定义导航，`heroCompact` 存 storage） |
| 品牌区「房间 XXXXXX ›」pill | 首页同位置 pill → 点进**房间码页** |
| 房间面板：当前房间 / 复制房间码 / 加入 / 新建 / 本机房间列表 / 导出 / 导入 | `pages/room/room`：同样功能，导入支持「剪贴板读取 + 粘贴 JSON」 |
| `localStorage`：`qinzhang_rooms_v1` + `qinzhang_room_<CODE>` + 迁移标记 | `wx.setStorageSync` 同 key 同结构（`utils/rooms.js`） |
| 旧数据 v3/v2/v1 自动迁移，只搬一次，旧 key 保留 | 同（`bootRooms()`），并有目录丢失时扫 key 自愈 |
| 导出 Blob 下载 | 导出 JSON **复制到剪贴板**（粘到文件传输助手即备份） |
| 导入文件：校验 → 预览 → 落到新房间 / 覆盖当前房间（二次确认） | 同：`normalizeImport` + `importDraft` 预览 + 两种落点 |
| 一句话记账 → 逐项核对（金额/项目/类别/垫付人/参与人/等额·按天） | 同（`pages/book`），附抽取 JSON 折叠查看 |
| 小票识别：AI 识图（预设、Base/Model/Key、JSON 模式）+ 粘贴票面文字 + 逐行核对 + 合并/逐条 | 同（`pages/receipt`），照片走 `wx.chooseMedia` + `readFile(base64)` |
| 明细：全部/未结清、逐人结清标签、该笔结清、撤销 | 同（`pages/list`） |
| 提醒：找谁 + 三种语气 + 复制；月报：4 指标 + 类别占比 + 文案 | 同（`pages/remind`）；who/tone 用原生 `picker` 代替自绘菜单 |
| 成员：2–8 人增删改、改名同步历史、已退出成员 | 同（`pages/members`） |

差异（小程序限制，已做等效处理）：自绘 SVG 图标 → emoji/文字；`navigator.clipboard` → `wx.setClipboardData`；`<details>` → 折叠区；网页 tab → 原生 `tabBar`。

---

## 二、目录结构

```
miniprogram/
├── app.js / app.json / app.wxss      全局入口、注册、设计系统（由 demo 样式翻译）
├── project.config.json / sitemap.json
├── assets/tabbar/                    10 张 tabBar 图标（灰/绿）
├── utils/
│   ├── finance.js    纯逻辑：分摊尾差、两两抵消结算、一句话解析、小票解析、AI 归一化、话术、月报
│   ├── rooms.js      房间码：目录/分区存储/迁移/新建/切换/导出/导入
│   ├── store.js      会话门面：getState / mutate / buildExpense / 清空 / 演示数据 / AI 配置
│   └── ai.js         多模态识图（wx.request → OpenAI 兼容 /chat/completions）
└── pages/
    ├── index/        首页（封面、每个人的账、待结清、最近记录）
    ├── book/         一句话记账 + 逐项核对
    ├── receipt/      小票识别（AI 识图 / 粘贴文字）
    ├── list/         明细
    ├── remind/       催缴话术 + 月报
    ├── members/      成员设置
    └── room/         房间码（加入/切换/新建/导出/导入）
```

---

## 三、打开方式

**A（推荐）**：开发者工具 → 导入项目 → 目录 `D:\小组作业\miniprogram` → AppID 选「测试号 / 无 AppID」→ 导入 → 按 `Ctrl+R` 编译。

**B（本机已配好）**：`C:\Users\aaa\WeChatProjects\miniprogram-1` 是指向本工程的**目录联接**；原模板备份为 `miniprogram-1.bak-161045`。删除联接：

```powershell
cmd /c rmdir "C:\Users\aaa\WeChatProjects\miniprogram-1"
```

---

## 四、AI 识图（可选）

小票页 →「🤖 AI 识图设置」：服务商选 **DeepSeek**，接口 `https://api.deepseek.com`，模型 `deepseek-flash`（**注意：v4-pro 不支持图像理解**），填 Key（只存本机 storage），建议开 JSON 模式。

- 真机必须把 `api.deepseek.com` 加进小程序后台的 **request 合法域名**（需备案 HTTPS）；本机调试可在「详情 → 本地设置」勾**不校验合法域名**。
- 不配 AI 也能用：把票面文字粘进文本框，走同一套解析。

---

## 五、验证（322 项）

| 套件 | 内容 | 结果 |
|---|---|---|
| 房间码/存储 | 房间码格式与字符表、目录与 current、新建/切换、重启保持、旧数据迁移幂等、导出载荷、导入校验与坏记录计数、导入新房间不覆盖、覆盖模式、50 次生成不重复、扫描自愈、清空/演示数据 | **56 项通过** |
| 业务逻辑 | 尾差、两两抵消、一句话解析、真实 OCR 票面、AI 归一化、改名同步、3/5/8 人重算、话术、月报 | **120 项通过** |
| 静态校验 | 12 个 JS 语法、JSON 合法、WXML 标签配对、事件处理器存在、页面四件套、tabBar 图标 | **146 项通过** |

---

## 六、已知限制

1. `touristappid` 只能本地模拟；真机预览要换成自己的 appid。
2. 导出为「复制 JSON 到剪贴板」，没有直接落盘（小程序沙箱不便写用户可见目录）；导入支持粘贴或剪贴板读取，暂不支持选文件。
3. tabBar 图标为脚本生成的简笔线性图标，替换 `assets/tabbar/*.png` 即可换风格。

---

## 七、编译自查（本地就能跑，不用开 IDE）

开发者工具自带官方编译器，本工程用它做过校验：

```powershell
powershell -ExecutionPolicy Bypass -File .\_tools\compile-check.ps1
```

- `wcsc.exe` → 编译全部 8 个 `*.wxss`
- `wcc.exe` → 编译全部 7 个 `*.wxml`
- 当前结果：**8/8 WXSS、7/7 WXML 全部 exit=0**

### 踩过的坑 2：WXML 没有 HTML 标签

首页原来用了 `<header class="topbar">`（照抄网页）。WXML 没有 `header` 组件，编译能过但运行时控制台报
`Component is not found in path "header"`，整块头部不渲染。现已改成 `<view class="topbar">`，样式不变。
全库已用脚本扫描：**7 个 wxml 只使用内置组件标签**。

### 踩过的坑 1：WXSS 不是完整 CSS

从网页 demo 翻译样式时，下面这些写法会被 `wcsc` 直接判为语法错误（报 `unexpected token`）：

| 写法 | 处理 |
|---|---|
| `*,*::before,*::after{...}` | 换成元素清单 `view,text,image,button,input,textarea,picker,scroll-view,...` |
| `input[type=number]` 等属性选择器 | 改成 `input`（保留基础样式）；`[aria-expanded]`/`[open]`/`[style*=]` 这类直接丢弃 |
| `:has(.b.pos)` | 改成同元素类 `.person.pos`（WXML 侧同步加类） |
| `::placeholder` / `:focus-visible` | 丢弃（小程序用 `placeholder-class`） |
| `@supports` / `@container` / `@layer` | 丢弃 |

其余（`:active` `:first-child` `:nth-child` `@media` `@keyframes` `var()` `calc()`）可正常编译。
