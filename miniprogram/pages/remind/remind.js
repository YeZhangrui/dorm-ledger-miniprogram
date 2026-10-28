const F = require('../../utils/finance.js');
const store = require('../../utils/store.js');

Page({
  data: {
    hasOpen: false,
    whoIndex: 0,
    whoOptions: [],   // 交给 sheet-select：{label: 谁 → 谁, desc: 明细, side: 金额}
    tones: [
      { key: 'soft', name: '委婉', desc: '金额小 / 关系好' },
      { key: 'fun', name: '幽默', desc: '熟 / 起哄用' },
      { key: 'direct', name: '直接', desc: '金额大 / 催过几次' }
    ],
    toneIndex: 0,
    remindText: '',
    report: { total: '¥0.00', per: '¥0.00', count: 0, ratio: 100, cats: [], text: '' }
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
    const open = F.unsettled(s.expenses);
    // 原生 picker 会把这一串渲染成系统滚轮（灰字、长文挤一行）；
    // 交给 sheet-select 后按「谁 → 谁 / 明细 / 金额」三栏展示，选中态用品牌绿。
    const whoOptions = open.map(function (o) {
      const detail = o.items.map(function (x) { return x.item + ' ' + F.fmt(x.amount); }).join(' · ');
      return {
        label: o.from + ' → ' + o.to,
        desc: detail + (o.offset > 0 ? '（已对冲 ' + F.fmt(o.offset) + '）' : ''),
        side: F.fmt(o.amount)
      };
    });
    const whoIndex = Math.min(this.data.whoIndex, Math.max(0, whoOptions.length - 1));
    const r = F.makeReport(s.expenses, s.members);
    this.setData({
      hasOpen: whoOptions.length > 0,
      whoIndex: whoIndex,
      whoOptions: whoOptions,
      report: {
        total: F.fmt(r.total),
        per: F.fmt(r.per),
        count: r.count,
        ratio: r.closedRatio,
        cats: r.cats.map(function (c) {
          const pct = Math.round(c.amount / (r.total || 1) * 100);
          return { cat: c.cat, icon: F.categoryIcon(c.cat), amountText: F.fmt(c.amount), pct: pct, w: Math.max(3, pct) };
        }),
        text: r.text
      }
    });
    this._open = open;
  },

  onWho: function (e) {
    const i = Number(e.detail.index);
    if (isFinite(i)) this.setData({ whoIndex: i });
  },

  onTone: function (e) {
    const i = Number(e.currentTarget.dataset.i);
    if (isFinite(i)) this.setData({ toneIndex: i });
  },

  generate: function () {
    const open = this._open || [];
    if (!open.length) {
      wx.showToast({ title: '当前没有待结清，不用催', icon: 'none' });
      return;
    }
    const o = open[this.data.whoIndex] || open[0];
    const tone = this.data.tones[this.data.toneIndex].key;
    this.setData({ remindText: F.makeReminder(o.from, o.to, o.amount, o.items, tone, o.offset || 0) });
  },

  copyRemind: function () {
    if (!this.data.remindText) return;
    wx.setClipboardData({
      data: this.data.remindText,
      success: function () { wx.showToast({ title: '已复制，去群里粘贴', icon: 'success' }); }
    });
  },

  copyReport: function () {
    if (!this.data.report.text) return;
    wx.setClipboardData({
      data: this.data.report.text,
      success: function () { wx.showToast({ title: '已复制月报', icon: 'success' }); }
    });
  }
});
