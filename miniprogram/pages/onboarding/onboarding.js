const api = require('../../utils/api.js');
const user = require('../../utils/user.js');
const store = require('../../utils/store.js');

Page({
  data: {
    // 启动页先判断是否已有房间，判断期间不渲染表单，避免老用户闪一下引导页
    checking: true,
    cloudReady: false,
    name: '',
    avatarUrl: '',
    roomName: '',
    joinCode: '',
    busy: '',
    hasLocal: false,
    localText: ''
  },

  onLoad: function (options) {
    const invite0 = (options && options.code) ? String(options.code).toUpperCase().slice(0, 6) : '';
    // 已有房间 / 未接云端 / 用户选了先不联网 → 直接进首页
    if (!invite0) {
      if (user.currentRoom() || !api.isReady() || user.isSkipCloud()) {
        this.goIndex();
        return;
      }
    }
    const that = this;
    user.refresh(true).then(function (u) {
      if (!invite0 && u && u.room) { that.goIndex(); return; }
      that.setData({ checking: false });
    }).catch(function () {
      that.setData({ checking: false });
    });
    // 从分享卡片进来时带着房间码，直接预填、少一步输入
    const invite = (options && options.code) ? String(options.code).toUpperCase().slice(0, 6) : '';
    const u = user.get();
    const profile = (u && u.profile) || null;
    let hasLocal = false;
    let localText = '';
    try {
      const s = store.getState();
      const n = (s.expenses || []).length;
      hasLocal = n > 0;
      localText = n
        ? '本机这本账有 ' + n + ' 笔记录、' + (s.members || []).length + ' 位成员，可以一键搬到云端（只搬一次）。'
        : '';
    } catch (e) {
      hasLocal = false;
    }
    this.setData({
      cloudReady: api.isReady(),
      inviteCode: invite,
      invited: !!invite,
      joinCode: invite,
      name: (profile && profile.name) || '',
      hasLocal: hasLocal,
      localText: localText
    });
  },

  onChooseAvatar: function (e) {
    const url = (e.detail && e.detail.avatarUrl) || '';
    if (url) this.setData({ avatarUrl: url });
  },

  onName: function (e) {
    this.setData({ name: e.detail.value });
  },

  onRoomName: function (e) {
    this.setData({ roomName: e.detail.value });
  },

  onJoinCode: function (e) {
    // 转大写、去掉空格和连字符，最多 6 位；字符是否合法交给云端校验（能给出更准确的中文提示）
    const raw = String(e.detail.value || '').toUpperCase();
    let out = '';
    for (let i = 0; i < raw.length && out.length < 6; i++) {
      const ch = raw.charAt(i);
      if (ch === ' ' || ch === '-' || ch === '_') continue;
      out += ch;
    }
    this.setData({ joinCode: out });
  },

  myName: function () {
    return String(this.data.name || '').trim();
  },

  /** 校验收尾：名字必填，云端也会再校验一次 */
  checkName: function () {
    const name = this.myName();
    if (!name) {
      wx.showToast({ title: '先填一个昵称，室友才知道是谁', icon: 'none' });
      return '';
    }
    if (name.length > 8) {
      wx.showToast({ title: '昵称最多 8 个字', icon: 'none' });
      return '';
    }
    return name;
  },

  /** 头像选了就先传上去，失败不挡主流程（大不了之后再改） */
  saveAvatar: function () {
    const that = this;
    const url = this.data.avatarUrl;
    if (!url || url.indexOf('cloud://') === 0) return Promise.resolve();
    return api.room.uploadAvatar(url).then(function (fileID) {
      that._avatarFileID = fileID;
      return api.room.updateProfile(undefined, fileID);
    }).catch(function () {
      return null;
    });
  },

  finish: function (room, profile) {
    user.setSkipCloud(false);
    user.setRoom(room, profile);
    wx.showToast({ title: '搞定，开始记账', icon: 'success' });
    setTimeout(function () {
      wx.switchTab({ url: '/pages/index/index' });
    }, 400);
  },

  onCreate: function () {
    const that = this;
    if (!this.data.cloudReady) {
      wx.showToast({ title: '还没接上云端，先用本机模式', icon: 'none' });
      return;
    }
    const name = this.checkName();
    if (!name) return;
    if (this.data.busy) return;
    const roomName = String(this.data.roomName || '').trim() || (name + '的寝室');
    this.setData({ busy: 'create' });
    api.room.create(roomName, name)
      .then(function (res) {
        const room = (res && res.room) || null;
        return that.saveAvatar().then(function () {
          that.setData({ busy: '' });
          that.finish(room, { name: name, avatarFileID: that._avatarFileID || '' });
        });
      })
      .catch(function (err) {
        that.setData({ busy: '' });
        wx.showModal({ title: '创建失败', content: (err && err.message) || '请稍后重试', showCancel: false });
      });
  },

  onJoin: function () {
    const that = this;
    if (!this.data.cloudReady) {
      wx.showToast({ title: '还没接上云端，先用本机模式', icon: 'none' });
      return;
    }
    const name = this.checkName();
    if (!name) return;
    const code = String(this.data.joinCode || '').trim();
    if (code.length !== 6) {
      wx.showToast({ title: '房间码是 6 位，再检查一下', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    this.setData({ busy: 'join' });
    api.room.join(code, name)
      .then(function (res) {
        const room = (res && res.room) || null;
        return that.saveAvatar().then(function () {
          that.setData({ busy: '' });
          that.finish(room, { name: name, avatarFileID: that._avatarFileID || '' });
        });
      })
      .catch(function (err) {
        that.setData({ busy: '' });
        wx.showModal({ title: '加入失败', content: (err && err.message) || '房间码可能不对', showCancel: false });
      });
  },

  /** 把本机账本搬到云端（迁移只做一次，云端会新建一个房间） */
  onImport: function () {
    const that = this;
    if (!this.data.cloudReady) {
      wx.showToast({ title: '还没接上云端，暂时不能迁移', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    let s;
    try {
      s = store.getState();
    } catch (e) {
      wx.showToast({ title: '读不到本机账本', icon: 'none' });
      return;
    }
    const members = (s.members || []).slice();
    const expenses = (s.expenses || []).slice();
    if (!members.length) {
      wx.showToast({ title: '本机没有成员，先在小程序里设好成员', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '把本机账本搬到云端？',
      content: '会在云端新建一个房间，把 ' + expenses.length + ' 笔记录和 ' + members.length + ' 位成员传上去。本机数据不会删除。',
      confirmText: '开始迁移',
      success: function (res) {
        if (!res.confirm) return;
        that.setData({ busy: 'import' });
        api.login.importLocal({ label: s.room && s.room.label ? s.room.label : '我的寝室', members: members, expenses: expenses })
          .then(function (data) {
            return api.login.whoami().then(function (u) {
              that.setData({ busy: '' });
              const room = (u && u.room) || (data && data.room) || null;
              that.finish(room, (u && u.profile) || { name: members[0] });
            });
          })
          .catch(function (err) {
            that.setData({ busy: '' });
            wx.showModal({ title: '迁移失败', content: (err && err.message) || '请稍后重试', showCancel: false });
          });
      }
    });
  },

  useLocal: function () {
    user.setSkipCloud(true);
    user.clear();
    wx.switchTab({ url: '/pages/index/index' });
  },

  goIndex: function () {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goAbout: function () {
    wx.navigateTo({ url: '/pages/about/about' });
  }
});
