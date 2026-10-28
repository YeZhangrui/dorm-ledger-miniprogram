const F = require('../../utils/finance.js');
const store = require('../../utils/store.js');
const api = require('../../utils/api.js');
const user = require('../../utils/user.js');

Page({
  data: {
    // 云端模式：成员是"加入了房间的人"，只能改自己的名字；房主可加人/移除
    isCloud: false,
    cloudRows: [],      // [{name, role, pending, isMe}]
    isOwner: false,
    myName: '',
    newName: '',
    addOpen: false,
    addName: '',
    roomCode: '',
    rows: [],
    meIndex: 0,
    hint: '支持 2–8 人：改人数就加/删一行，改名字直接编辑。改名会同步所有历史记录；删掉的成员历史账目仍保留，显示为“已退出”。'
  },

  /** 下拉刷新：重新拉一次云端成员列表 */
  onPullDownRefresh: function () {
    const that = this;
    store.loadThen(function () { that.refresh(); }).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  onLoad: function () {
    this._seq = 1;
    const that = this;
    store.loadThen(function () {
      that.refresh();
    });
  },

  refresh: function () {
    const that = this;
    if (store.isCloud()) {
      const room = user.currentRoom() || {};
      this.setData({ isCloud: true, roomCode: room.code || '' });
      return store.members().then(function (list) {
        const me = list.filter(function (m) { return m.isMe; })[0] || null;
        that.setData({
          cloudRows: list,
          isOwner: !!(me && me.role === 'owner'),
          myName: (me && me.name) || ''
        });
      });
    }

    const s = store.getState();
    const meIndex = Math.max(0, s.members.indexOf(s.me));
    this.setData({
      isCloud: false,
      rows: s.members.map(function (m, i) {
        return { id: 'm' + i, orig: m, name: m };
      }),
      meIndex: meIndex
    });
  },

  /* ---------------- 云端模式：只改自己 / 房主加人移除 ---------------- */

  onMyNameInput: function (e) {
    this.setData({ newName: e.detail.value });
  },

  saveMyName: function () {
    const that = this;
    const name = String(this.data.newName || '').trim() || String(this.data.myName || '').trim();
    if (!name) {
      wx.showToast({ title: '名字不能为空', icon: 'none' });
      return;
    }
    store.renameMe(name).then(function () {
      that.setData({ newName: '' });
      return that.refresh();
    }).then(function () {
      wx.showToast({ title: '已更新', icon: 'success' });
    }).catch(function (err) {
      wx.showModal({ title: '改名失败', content: (err && err.message) || '请稍后重试', showCancel: false });
    });
  },

  /** 打开自绘的「添加室友」弹窗（不用系统灰弹窗） */
  onAddCloud: function () {
    this.setData({ addOpen: true, addName: '' });
  },

  onAddName: function (e) {
    this.setData({ addName: e.detail.value });
  },

  onAddCancel: function () {
    this.setData({ addOpen: false });
  },

  onAddConfirm: function () {
    const that = this;
    const name = String(this.data.addName || '').trim();
    if (!name) {
      wx.showToast({ title: '先填个名字', icon: 'none' });
      return;
    }
    api.room.addMember(name).then(function () {
      return store.load();
    }).then(function () {
      that.setData({ addOpen: false });
      return that.refresh();
    }).then(function () {
      wx.showToast({ title: '已添加，等他用同名加入', icon: 'none' });
    }).catch(function (err) {
      wx.showModal({ title: '添加失败', content: (err && err.message) || '请稍后重试', showCancel: false });
    });
  },

  noop: function () {},

  onRemoveCloud: function (e) {
    const that = this;
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    wx.showModal({
      title: '移除成员',
      content: '把「' + name + '」移出房间？历史账目会保留，余额里显示为"已退出"，欠的钱照样算。',
      confirmText: '移除',
      confirmColor: '#a33a3a',
      success: function (res) {
        if (!res.confirm) return;
        api.room.removeMember(name).then(function () {
          return store.load();
        }).then(function () {
          return that.refresh();
        }).then(function () {
          wx.showToast({ title: '已移除', icon: 'none' });
        }).catch(function (err) {
          wx.showModal({ title: '移除失败', content: (err && err.message) || '请稍后重试', showCancel: false });
        });
      }
    });
  },

  goRoom: function () {
    wx.navigateTo({ url: '/pages/room/room' });
  },

  /* ---------------- 本机模式：原来的整表编辑 ---------------- */

  onName: function (e) {
    const i = Number(e.currentTarget.dataset.i);
    const rows = this.data.rows.slice();
    rows[i] = Object.assign({}, rows[i], { name: e.detail.value });
    this.setData({ rows: rows });
  },

  onSetMe: function (e) {
    this.setData({ meIndex: Number(e.detail.value) });
  },

  onAdd: function () {
    const rows = this.data.rows.slice();
    if (rows.length >= F.MAX_MEMBERS) {
      wx.showToast({ title: '最多 ' + F.MAX_MEMBERS + ' 人', icon: 'none' });
      return;
    }
    this._seq = (this._seq || 1) + 1;
    rows.push({ id: 'n' + this._seq, orig: '', name: '' });
    this.setData({ rows: rows });
  },

  onDel: function (e) {
    const i = Number(e.currentTarget.dataset.i);
    const row = this.data.rows[i];
    const name = String(row.name || '').trim();
    const s = store.getState();
    const hasHistory = (s.expenses || []).some(function (x) {
      return x.payer === name || (x.participants || []).some(function (p) { return p.name === name; });
    });
    const that = this;
    const doRemove = function () {
      const next = that.data.rows.slice();
      next.splice(i, 1);
      let meIndex = that.data.meIndex;
      if (i < meIndex) meIndex -= 1;
      if (meIndex > next.length - 1) meIndex = next.length - 1;
      that.setData({ rows: next, meIndex: Math.max(0, meIndex) });
    };
    if (hasHistory && row.orig) {
      wx.showModal({
        title: '删除成员',
        content: '“' + name + '”已经有历史账目和分摊记录。删除后他会显示为“已退出”，历史账目保留，未结清的钱仍要还。',
        confirmText: '删除',
        confirmColor: '#a33a3a',
        success: function (res) { if (res.confirm) doRemove(); }
      });
      return;
    }
    doRemove();
  },

  onSave: function () {
    const that = this;
    const rows = this.data.rows.map(function (r) {
      return { orig: r.orig, name: String(r.name || '').trim() };
    });

    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].name) {
        wx.showToast({ title: '第 ' + (i + 1) + ' 行的名字不能为空', icon: 'none' });
        return;
      }
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[i].name === rows[j].name) {
          wx.showToast({ title: '名字重复了：' + rows[i].name, icon: 'none' });
          return;
        }
      }
    }
    if (rows.length < F.MIN_MEMBERS) {
      wx.showToast({ title: '至少要 ' + F.MIN_MEMBERS + ' 人', icon: 'none' });
      return;
    }
    if (rows.length > F.MAX_MEMBERS) {
      wx.showToast({ title: '最多 ' + F.MAX_MEMBERS + ' 人', icon: 'none' });
      return;
    }

    const pickedIndex = Math.max(0, Math.min(this.data.meIndex, rows.length - 1));
    const renamed = [];
    const renamedOld = [];
    let added = [];
    let removed = [];

    store.mutate(function (s) {
      const before = F.knownPeople(s.members, s.expenses);
      let cur = { members: s.members.slice(), me: s.me, expenses: s.expenses.slice() };

      rows.forEach(function (r) {
        if (r.orig && r.orig !== r.name) {
          cur = F.renameMember(cur, r.orig, r.name);
          renamed.push(r.name);
          renamedOld.push(r.orig);
        }
      });

      const nextMembers = rows.map(function (r) { return r.name; });
      removed = before.filter(function (n) { return nextMembers.indexOf(n) < 0; });
      added = nextMembers.filter(function (n) { return before.indexOf(n) < 0; });

      cur.members = nextMembers;
      cur.me = rows[pickedIndex] ? rows[pickedIndex].name : nextMembers[0];
      s.members = cur.members;
      s.me = cur.me;
      s.expenses = cur.expenses;
    });

    const parts = [];
    if (renamed.length) parts.push('已改名 ' + renamed.join('、'));
    if (added.length) parts.push('已添加 ' + added.join('、'));
    if (removed.length) parts.push('已退出 ' + removed.join('、'));
    wx.showToast({ title: parts.length ? parts.join('；') : '已保存', icon: 'none' });
    wx.navigateBack();
  }
});
