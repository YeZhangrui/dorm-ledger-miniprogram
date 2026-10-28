const F = require('../../utils/finance.js');
const store = require('../../utils/store.js');
const rooms = require('../../utils/rooms.js');
const env = require('../../config/env.js');
const api = require('../../utils/api.js');
const user = require('../../utils/user.js');

Page({
  data: {
    // 正式版不显示「粘贴 JSON 导入」（上线后由迁移向导取代，见 docs/上线改造清单.md 8.3）
    showDevTools: env.showDevTools && !env.cloudLedger,
    cloudReady: false,
    cloudRoom: null,
    code: '',
    label: '',
    count: 0,
    totalText: '¥0.00',
    rooms: [],
    joinText: '',
    importing: false,
    importText: '',
    importDraft: null,
    importInfo: ''
  },

  /** 分享给室友 */
  onShareAppMessage: function () {
    const r = user.currentRoom();
    return {
      title: r ? '加入我的寝室账本（房间码 ' + r.code + '）' : '寝账 · 寝室公共开支记账',
      path: r ? '/pages/onboarding/onboarding?code=' + r.code : '/pages/index/index'
    };
  },

  /** 重置房间码：旧码立即失效，防止被外人猜到 */
  resetCloudCode: function () {
    const that = this;
    wx.showModal({
      title: '重置房间码',
      content: '旧房间码会立刻失效，已经加入的室友不受影响；新室友要用新码加入。',
      confirmText: '重置',
      success: function (res) {
        if (!res.confirm) return;
        api.room.resetCode().then(function (r) {
          return user.refresh(true).then(function () {
            that.refresh();
            wx.showToast({ title: '新房间码 ' + ((r && r.code) || ''), icon: 'none' });
          });
        }).catch(function (err) {
          wx.showModal({ title: '重置失败', content: (err && err.message) || '请稍后重试', showCancel: false });
        });
      }
    });
  },

  /** 退出房间 */
  leaveCloudRoom: function () {
    const that = this;
    wx.showModal({
      title: '退出房间',
      content: '退出后你就看不到这本账了，历史记录仍留在房间里；想回来需要重新用房间码加入。',
      confirmText: '退出',
      confirmColor: '#a33a3a',
      success: function (res) {
        if (!res.confirm) return;
        api.room.leave().then(function () {
          user.clear();
          wx.reLaunch({ url: '/pages/onboarding/onboarding' });
        }).catch(function (err) {
          wx.showModal({ title: '退出失败', content: (err && err.message) || '请稍后重试', showCancel: false });
        });
      }
    });
  },

  /** 解散房间（房主） */
  dissolveCloudRoom: function () {
    const that = this;
    wx.showModal({
      title: '解散房间',
      content: '解散后所有成员都看不到这本账，且不可恢复。建议先导出备份。',
      confirmText: '解散',
      confirmColor: '#a33a3a',
      success: function (res) {
        if (!res.confirm) return;
        api.room.dissolve().then(function () {
          user.clear();
          wx.reLaunch({ url: '/pages/onboarding/onboarding' });
        }).catch(function (err) {
          wx.showModal({ title: '解散失败', content: (err && err.message) || '请稍后重试', showCancel: false });
        });
      }
    });
  },

  /** 下拉刷新：室友刚记的账，下拉一下就能看到（只对云端模式有意义，本机模式刷新也无害） */
  onPullDownRefresh: function () {
    const that = this;
    store.loadThen(function () { that.refresh(); }).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  onShow: function () {
    const that = this;
    store.loadThen(function () { that.refresh(); });
  },

  refresh: function () {
    const s = store.getState();
    let total = 0;
    s.expenses.forEach(function (e) { total += F.num(e.amount); });
    this.setData({
      code: s.room.code,
      label: s.room.label || '房间 ' + s.room.code,
      count: s.expenses.length,
      totalText: F.fmt(total),
      rooms: rooms.roomSummary(),
      // 云端身份：已连接云并加入了房间时，用来和"本机账本"区分开
      cloudReady: api.isReady(),
      cloudRoom: user.currentRoom()
    });
    // 缓存过期时顺手刷一次（失败不影响页面）
    const that = this;
    user.refresh().then(function (room) {
      const cur = user.currentRoom();
      if (that.data.cloudRoom && cur && that.data.cloudRoom.code !== cur.code) that.setData({ cloudRoom: cur });
    });
  },

  goOnboarding: function () {
    wx.navigateTo({ url: '/pages/onboarding/onboarding' });
  },

  /**
   * 云端自检：逐个敲 login/room/expense/ai，把"没部署 / 正常 / 网络异常"直接告诉用户，
   * 省得看到「云函数还没部署」却不知道是哪个、也不知道去哪看。
   */
  checkCloud: function () {
    if (!api.isReady()) {
      wx.showModal({ title: '云端自检', content: '还没配置云环境 ID（miniprogram/config/env.js 的 develop 一项）', showCancel: false });
      return;
    }
    const app = getApp();
    const g = (app && app.globalData) || {};
    const envLine = '环境：' + require('../../config/env.js').cloudEnvId + '\n初始化：' +
      (g.cloudInited ? '✅ 已连上' : '❌ 失败 ' + (g.cloudInitError || ''));
    const names = ['login', 'room', 'expense', 'ai'];
    const label = { ok: '✅ 正常', missing: '❌ 没部署', error: '❌ 调用失败' };
    wx.showLoading({ title: '检测中…', mask: true });
    Promise.all(names.map(function (n) {
      return api.ping(n).then(function (r) {
        return n + '：' + label[r];
      });
    })).then(function (lines) {
      wx.hideLoading();
      const bad = lines.filter(function (l) { return l.indexOf('✅') < 0; });
      const tail = bad.length
        ? '\n\n处理：① 确认 5 个函数都在 ' + require('../../config/env.js').cloudEnvId + ' 这个环境；② 重新"上传并部署：云端安装依赖"。'
        : '\n\n云端一切正常。';
      wx.showModal({
        title: '云端自检结果',
        content: envLine + '\n' + lines.join('\n') + tail,
        showCancel: false
      });
    });
  },

  onJoinInput: function (e) {
    this.setData({ joinText: e.detail.value });
  },

  join: function () {
    const code = rooms.normalizeRoomCode(this.data.joinText);
    if (!code) {
      wx.showToast({ title: '房间码是 6 位字母数字（已避开 0/O/1/I/l）', icon: 'none' });
      return;
    }
    const existed = !!rooms.readRoom(code);
    store.switchRoom(code);
    this.setData({ joinText: '' });
    this.refresh();
    wx.showToast({
      title: existed ? '已切换到房间 ' + code : '本机没有，已新建空房间 ' + code,
      icon: 'none'
    });
  },

  createNew: function () {
    const code = store.newRoom();
    this.refresh();
    if (!code) {
      wx.showToast({ title: '房间码生成失败，请重试', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已新建空房间 ' + code, icon: 'none' });
  },

  goAbout: function () {
    wx.navigateTo({ url: '/pages/about/about' });
  },

  pickRoom: function (e) {    const code = e.currentTarget.dataset.code;
    if (!code || code === this.data.code) return;
    store.switchRoom(code);
    this.refresh();
    wx.showToast({ title: '已切换到房间 ' + code, icon: 'none' });
  },

  copyCode: function () {
    // 之前这里写成「对象字面量.bind(...)」，对象没有 bind，一点就 TypeError；顺带修掉未声明的 that_code
    const code = this.data.code;
    wx.setClipboardData({
      data: code,
      success: function () {
        wx.showToast({ title: '房间码 ' + code + ' 已复制', icon: 'none' });
      }
    });
  },

  exportJson: function () {
    const payload = rooms.buildExportPayload();
    let json = '';
    try {
      json = JSON.stringify(payload, null, 2);
    } catch (e) {
      wx.showToast({ title: '导出失败', icon: 'none' });
      return;
    }
    const that = this;
    wx.setClipboardData({
      data: json,
      success: function () {
        wx.showModal({
          title: '已复制到剪贴板',
          content: '房间 ' + payload.room + ' · ' + payload.expenses.length + ' 笔 · ' + payload.members.length + ' 人\n\n粘到微信「文件传输助手」或记事本里保存即可；对方拿到这段 JSON 就能导入。',
          showCancel: false
        });
      }
    });
  },

  openImport: function () {
    this.setData({ importing: true, importText: '', importDraft: null, importInfo: '' });
  },

  closeImport: function () {
    this.setData({ importing: false, importText: '', importDraft: null, importInfo: '' });
  },

  onImportInput: function (e) {
    this.setData({ importText: e.detail.value });
  },

  readClipboard: function () {
    const that = this;
    wx.getClipboardData({
      success: function (res) {
        const text = String((res && res.data) || '');
        if (!text.trim()) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' });
          return;
        }
        that.setData({ importText: text });
        that.parseImport();
      }
    });
  },

  parseImport: function () {
    const text = String(this.data.importText || '').trim();
    if (!text) {
      wx.showToast({ title: '先把 JSON 粘进来', icon: 'none' });
      return;
    }
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      wx.showToast({ title: '不是合法的 JSON', icon: 'none' });
      return;
    }
    const draft = rooms.normalizeImport(obj);
    if (!draft) {
      wx.showToast({ title: '缺少 expenses 数组，不是本项目导出的文件', icon: 'none' });
      return;
    }
    const info = '来自房间 ' + (draft.room || '—') +
      ' · ' + draft.expenses.length + ' 笔 · ' + draft.members.length + ' 人' +
      (draft.skipped ? ' · 跳过 ' + draft.skipped + ' 条坏记录' : '');
    this.setData({ importDraft: draft, importInfo: info });
  },

  applyNew: function () {
    const draft = this.data.importDraft;
    if (!draft) return;
    const res = rooms.applyImport(draft, 'new');
    this.closeImport();
    this.refresh();
    if (!res) {
      wx.showToast({ title: '导入失败', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '已导入到新房间 ' + res.code,
      content: '共 ' + res.count + ' 笔，当前账本没有被覆盖。',
      showCancel: false
    });
  },

  applyOverwrite: function () {
    const draft = this.data.importDraft;
    if (!draft) return;
    const that = this;
    const cur = store.getState();
    wx.showModal({
      title: '覆盖当前房间？',
      content: '当前房间 ' + cur.room.code + ' 有 ' + cur.expenses.length + ' 笔账，将被这份 ' +
        draft.expenses.length + ' 笔的账本替换。旧账不会自动备份，取消则什么都不变。',
      confirmText: '确认覆盖',
      confirmColor: '#a33a3a',
      success: function (r) {
        if (!r.confirm) return;
        const res = rooms.applyImport(draft, 'overwrite');
        that.closeImport();
        that.refresh();
        wx.showToast({ title: res ? '已覆盖，共 ' + res.count + ' 笔' : '导入失败', icon: 'none' });
      }
    });
  }
});
