const env = require('./config/env.js');

App({
  onLaunch: function () {
    // 云开发：只有 config/env.js 里填了环境 ID 才会初始化，
    // 没填时保持"纯本机模式"，不影响本机账本继续用。
    this.globalData.cloudInited = false;
    this.globalData.cloudInitError = '';
    if (env.cloudEnabled) {
      try {
        wx.cloud.init({ env: env.cloudEnvId, traceUser: true });
        this.globalData.cloudInited = true;
        console.log('[cloud] 已连接环境', env.cloudEnvId);
      } catch (e) {
        const msg = (e && (e.errMsg || e.message)) || String(e);
        this.globalData.cloudInitError = msg;
        console.error('[cloud] 初始化失败', msg);
      }
    } else {
      console.warn('[env] 未配置云环境 ID，走本机存储模式（config/env.js）');
    }

    // 本机存储初始化（接入云端后这里只作为缓存与迁移数据源）
    try {
      const store = require('./utils/store.js');
      store.getState();
    } catch (e) {
      console.error('初始化失败', e);
    }
  },

  globalData: {
    version: '2.0.0',
    env: env,
    cloudInited: false,
    cloudInitError: ''
  }
});
