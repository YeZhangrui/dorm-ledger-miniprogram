/**
 * 环境与开关（客户端唯一的环境配置出口）
 *
 * 已配置：开发版环境 dorm-dev-d8gvebn3qc576fd27
 * （用开发者工具 CLI `cli cloud env list --project <工程>` 核对过，
 *  5 个云函数 login/room/expense/ai/backup 都部署在这个环境里）
 *
 * 体验版 / 正式版暂时回落到同一个环境；正式上线前建议再建一个 prod 环境，
 * 把 release 单独填上，做到开发数据与用户数据隔离。
 *
 * 没填的时候 `cloudEnabled = false`，客户端保持"纯本机模式"；
 * 填了之后 app.js 才会 wx.cloud.init，页面才会走 utils/api.js 的云端接口。
 */

const ENV_IDS = {
  develop: 'dorm-dev-d8gvebn3qc576fd27',   // 开发版
  trial: '',     // 体验版（暂用开发版环境）
  release: ''    // 正式版（上线前建议单独建）
};

function detectEnvVersion() {
  try {
    const info = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null;
    const v = info && info.miniProgram && info.miniProgram.envVersion;
    return v || 'develop';
  } catch (e) {
    return 'develop';
  }
}

const envVersion = detectEnvVersion();
// 只建了一个环境时，体验版/正式版回落到开发环境；上线前再拆开
const cloudEnvId = ENV_IDS[envVersion] || ENV_IDS.develop;

module.exports = {
  envVersion: envVersion,
  cloudEnvId: cloudEnvId,
  /** 是否已接入云开发（决定走云端还是本机） */
  cloudEnabled: !!cloudEnvId && typeof wx !== 'undefined' && !!wx.cloud,
  /**
   * 账本数据是否走云端。
   * 已打开：7 个页面都改成"先拉云端再渲染"，记账/结算/撤销/成员管理都会同步到云函数。
   * 关掉它就回到纯本机模式（本机那本账还在，可以随时切回来排查问题）。
   */
  cloudLedger: true,
  isRelease: envVersion === 'release',
  /** 正式版隐藏「演示数据 / 清空 / 导入 JSON」这类开发入口 */
  showDevTools: envVersion !== 'release',
  /** AI 识图每日次数上限（与服务端 usage 集合保持一致） */
  aiDailyQuota: 10
};
