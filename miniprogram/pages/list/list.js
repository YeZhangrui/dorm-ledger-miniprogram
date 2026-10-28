const F = require('../../utils/finance.js');
const store = require('../../utils/store.js');
const api = require('../../utils/api.js');
const user = require('../../utils/user.js');

Page({
  data: {
    filter: 'open',
    records: [],
    emptyText: '还没有记录',
    // 编辑弹层：只改最容易记错的三个字段（金额/项目/日期），改完由云端重算分摊
    editing: null,
    editAmount: '',
    editItem: '',
    editDate: '',
    isOwner: false,
    // 结清流水弹层：{ title, items } | null
    logsFor: null
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
    const room = user.currentRoom();
    this.setData({ isOwner: !!(room && room.role === 'owner') });
    const s = store.getState();
    const openOnly = this.data.filter === 'open';
    const list = s.expenses.slice().sort(function (a, b) {
      return (b.date + b.id) < (a.date + a.id) ? -1 : 1;
    });
    const use = openOnly ? list.filter(function (e) { return F.unsettledItems([e]).length > 0; }) : list;
    const records = use.map(function (e) {
      const shares = e.shares || F.computeShares(e.amount, e.participants);
      const chips = shares.map(function (p) {
        const done = p.name === e.payer ? true : !!(e.settled && e.settled[p.name]);
        return {
          name: p.name,
          cls: done ? 'ok' : 'no',
          text: p.name + (F.isExMember(s.members, p.name) ? '（已退出）' : '') + ' ' +
            F.fmt(p.share) + (done ? ' ✓' : ' 未结')
        };
      });
      return {
        id: e.id,
        mine: !!e.createdByMe,
        icon: F.categoryIcon(e.category),
        item: e.item,
        date: e.date,
        raw: e.raw || e.item,
        amountText: F.fmt(e.amount),
        payer: e.payer,
        chips: chips,
        isReceipt: e.source === 'receipt',
        receiptText: e.source === 'receipt'
          ? (e.receipt && e.receipt.merchant ? '（' + e.receipt.merchant + '）' : '')
          : ''
      };
    });
    this.setData({
      records: records,
      emptyText: openOnly ? '没有未结清的记录' : '还没有记录，去“记账”说一句吧'
    });
  },

  /* ---------------- 结清流水 ---------------- */

  onLogs: function (e) {
    const id = e.currentTarget.dataset.id;
    const rec = this.data.records.filter(function (x) { return x.id === id; })[0];
    const that = this;
    wx.showLoading({ title: '读流水…', mask: true });
    api.expense.logs(id).then(function (res) {
      wx.hideLoading();
      const items = (res.items || []).map(function (x) {
        const d = new Date(x.at || 0);
        const mm = ("0" + (d.getMonth() + 1)).slice(-2);
        const dd = ("0" + d.getDate()).slice(-2);
        const hh = ("0" + d.getHours()).slice(-2);
        const mi = ("0" + d.getMinutes()).slice(-2);
        return {
          key: x.expenseId + ':' + x.from + ':' + x.at,
          text: (x.action === 'undo' ? '撤销结清' : '结清') + '：' + x.from + ' → ' + x.to,
          amountText: F.fmt(x.amount),
          meta: (x.byName || '某人') + ' · ' + mm + '-' + dd + ' ' + hh + ':' + mi
        };
      });
      that.setData({
        logsFor: {
          title: (rec ? rec.item : '这笔账') + ' 的结清记录',
          items: items
        }
      });
    }).catch(function (err) {
      wx.hideLoading();
      wx.showModal({ title: '读不到流水', content: (err && err.message) || '请稍后重试', showCancel: false });
    });
  },

  onLogsClose: function () { this.setData({ logsFor: null }); },

  /* ---------------- 编辑这笔 ---------------- */

  /** 弹层面板上的点击不要冒泡到遮罩 */
  noop: function () {},

  onEditOpen: function (e) {
    const id = e.currentTarget.dataset.id;
    const rec = store.getState().expenses.filter(function (x) { return x.id === id; })[0];
    if (!rec) return;
    this.setData({
      editing: { id: rec.id, amountText: F.fmt(rec.amount), payer: rec.payer },
      editAmount: F.plain(rec.amount),
      editItem: rec.item,
      editDate: rec.date
    });
  },

  onEditAmount: function (e) { this.setData({ editAmount: e.detail.value }); },
  onEditItem: function (e) { this.setData({ editItem: e.detail.value }); },
  onEditDate: function (e) { this.setData({ editDate: e.detail.value }); },
  onEditCancel: function () { this.setData({ editing: null }); },

  onEditSave: function () {
    const that = this;
    const d = this.data;
    if (!d.editing) return;
    const amount = Number(d.editAmount);
    if (!(amount > 0)) {
      wx.showToast({ title: '金额要大于 0', icon: 'none' });
      return;
    }
    const item = String(d.editItem || '').trim();
    if (!item) {
      wx.showToast({ title: '项目不能为空', icon: 'none' });
      return;
    }
    const patch = { amount: F.num(amount), item: item, date: String(d.editDate || '').slice(0, 10) };
    wx.showLoading({ title: '保存中…', mask: true });
    api.expense.update(d.editing.id, patch).then(function () {
      return store.load();
    }).then(function () {
      wx.hideLoading();
      that.setData({ editing: null });
      that.refresh();
      wx.showToast({ title: '已保存', icon: 'success' });
    }).catch(function (err) {
      wx.hideLoading();
      wx.showModal({ title: '保存失败', content: (err && err.message) || '请稍后重试', showCancel: false });
    });
  },

  setFilter: function (e) {
    this.setData({ filter: e.currentTarget.dataset.filter }, this.refresh);
  },

  onTogglePerson: function (e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    store.mutate(function (s) {
      s.expenses = s.expenses.map(function (x) {
        if (x.id !== id) return x;
        const settled = Object.assign({}, x.settled || {});
        settled[name] = !settled[name];
        return Object.assign({}, x, { settled: settled });
      });
    });
    this.refresh();
  },

  onClearOne: function (e) {
    const id = e.currentTarget.dataset.id;
    store.mutate(function (st) {
      st.expenses = st.expenses.map(function (x) {
        if (x.id !== id) return x;
        const settled = {};
        (x.participants || []).forEach(function (p) { settled[p.name] = true; });
        return Object.assign({}, x, { settled: settled });
      });
    });
    this.refresh();
    wx.showToast({ title: '该笔已结清', icon: 'success' });
  },

  onRemove: function (e) {
    const id = e.currentTarget.dataset.id;
    const s = store.getState();
    const rec = s.expenses.filter(function (x) { return x.id === id; })[0];
    if (!rec) return;
    const that = this;
    wx.showModal({
      title: '撤销这笔',
      content: rec.item + ' ' + F.fmt(rec.amount) + '（' + rec.payer + ' 垫付）',
      confirmText: '撤销',
      confirmColor: '#a33a3a',
      success: function (res) {
        if (!res.confirm) return;
        store.mutate(function (st) {
          st.expenses = st.expenses.filter(function (x) { return x.id !== id; });
        });
        that.refresh();
        wx.showToast({ title: '已撤销', icon: 'none' });
      }
    });
  }
});
