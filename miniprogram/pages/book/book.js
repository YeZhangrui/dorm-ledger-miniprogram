const F = require('../../utils/finance.js');
const store = require('../../utils/store.js');

Page({
  data: {
    me: '',
    memberNames: [],
    input: '',
    samples: [],
    draft: null,
    warnings: [],
    categories: F.CATEGORIES,
    catOptions: F.CATEGORIES.map(function (c) { return { label: c }; }),
    payerOptions: [],
    catIndex: 0,
    payerIndex: 0,
    amount: '',
    item: '',
    parts: [],
    mode: 'equal',
    jsonText: '',
    confText: '',
    foldOpen: false
  },

  onShow: function () {
    const that = this;
    store.loadThen(function () { that.boot(); });
  },

  boot: function () {
    const s = store.getState();
    const N = s.members.length;
    const other = s.members[1] || s.members[0];
    this.setData({
      me: s.me,
      memberNames: s.members,
      payerOptions: s.members.map(function (m) { return { label: m }; }),
      samples: [
        '今天买水 12.4 ' + F.cnWord(N) + '个人分',
        '我垫了网费 120，全寝室 AA',
        '电费 86 块 4，平摊',
        '空调电费我和' + other + '分，一共 60',
        N >= 3 ? '公共零食 45，除了我之外的' + F.cnWord(N - 1) + '个人分' : '公共零食 45，全寝室 AA'
      ]
    });
  },

  onInput: function (e) {
    this.setData({ input: e.detail.value });
  },

  useSample: function (e) {
    this.setData({ input: e.currentTarget.dataset.text });
  },

  onParse: function () {
    const s = store.getState();
    const text = this.data.input;
    if (!String(text || '').trim()) {
      wx.showToast({ title: '先说一句，例如“今天买水 12.4 四个人分”', icon: 'none' });
      return;
    }
    const r = F.parseExpense(text, s.members, s.me);
    if (!r.ok) wx.showToast({ title: r.warnings[0] || '没听懂，换个说法试试', icon: 'none' });
    const parts = s.members.map(function (m) {
      return { name: m, on: r.parts.indexOf(m) >= 0, days: 30 };
    });
    this.setData({
      draft: r,
      amount: r.amount ? F.plain(r.amount) : '',
      item: r.item,
      catIndex: Math.max(0, F.CATEGORIES.indexOf(r.category)),
      payerIndex: Math.max(0, s.members.indexOf(r.payer)),
      parts: parts,
      mode: r.mode,
      warnings: r.warnings,
      foldOpen: false
    });
    this.syncJson();
  },

  onAmount: function (e) {
    this.setData({ amount: e.detail.value });
    this.syncJson();
  },

  onItem: function (e) {
    this.setData({ item: e.detail.value });
    this.syncJson();
  },

  onCat: function (e) {
    this.setData({ catIndex: Number(e.detail.index) });
    this.syncJson();
  },

  onPayer: function (e) {
    const idx = Number(e.detail.index);
    const name = this.data.memberNames[idx];
    const parts = this.data.parts.map(function (p) {
      return p.name === name ? Object.assign({}, p, { on: true }) : p;
    });
    this.setData({ payerIndex: idx, parts: parts });
    this.syncJson();
  },

  togglePart: function (e) {
    const i = Number(e.currentTarget.dataset.i);
    const parts = this.data.parts.slice();
    const onCount = parts.filter(function (p) { return p.on; }).length;
    if (parts[i].on && onCount <= 1) {
      wx.showToast({ title: '至少要留一个人参与', icon: 'none' });
      return;
    }
    parts[i] = Object.assign({}, parts[i], { on: !parts[i].on });
    this.setData({ parts: parts });
    this.syncJson();
  },

  onDays: function (e) {
    const i = Number(e.currentTarget.dataset.i);
    const parts = this.data.parts.slice();
    parts[i] = Object.assign({}, parts[i], { days: Math.max(1, Number(e.detail.value) || 1) });
    this.setData({ parts: parts });
    this.syncJson();
  },

  setMode: function (e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
    this.syncJson();
  },

  syncJson: function () {
    const d = this.data;
    const selected = d.parts.filter(function (p) { return p.on; });
    if (!selected.length) {
      this.setData({ jsonText: '', confText: '' });
      return;
    }
    const mode = d.mode;
    const parts = selected.map(function (p) {
      return { name: p.name, weight: mode === 'days' ? Math.max(1, p.days || 30) : 1 };
    });
    const amount = F.num(parseFloat(d.amount) || 0);
    const shares = F.computeShares(amount, parts);
    const payload = {
      amount: amount,
      item: d.item || '公共开支',
      category: F.CATEGORIES[d.catIndex] || '其他',
      payer: d.memberNames[d.payerIndex] || d.me,
      splitMode: mode,
      participants: shares.map(function (s) { return { name: s.name, weight: s.weight, share: s.share }; }),
      settled: '全部未结清',
      confidence: (d.draft && d.draft.confidence) || 0.8,
      warnings: d.warnings,
      raw: (d.draft && d.draft.raw) || '',
      source: 'nl'
    };
    const tail = shares.some(function (s) { return s.tail; });
    this.setData({
      jsonText: JSON.stringify(payload, null, 2),
      confText: '置信度 ' + Math.round(payload.confidence * 100) + '%' + (tail ? ' · 已处理尾差' : '')
    });
  },

  onConfirm: function () {
    const d = this.data;
    const amount = F.num(parseFloat(d.amount) || 0);
    if (!(amount > 0)) {
      wx.showToast({ title: '金额要大于 0', icon: 'none' });
      return;
    }
    const selected = d.parts.filter(function (p) { return p.on; });
    if (!selected.length) {
      wx.showToast({ title: '至少留一个参与人', icon: 'none' });
      return;
    }
    const participants = selected.map(function (p) {
      return { name: p.name, weight: d.mode === 'days' ? Math.max(1, p.days || 30) : 1 };
    });
    const rec = store.buildExpense({
      amount: amount,
      item: d.item || '公共开支',
      category: F.CATEGORIES[d.catIndex] || '其他',
      payer: d.memberNames[d.payerIndex] || d.me,
      participants: participants,
      mode: d.mode,
      source: 'nl',
      raw: (d.draft && d.draft.raw) || ''
    });
    store.mutate(function (s) { s.expenses.unshift(rec); });
    this.setData({ draft: null, input: '', amount: '', item: '', jsonText: '', confText: '', warnings: [] });
    wx.showToast({ title: '已入账 ' + F.fmt(amount), icon: 'success' });
    setTimeout(function () {
      wx.switchTab({ url: '/pages/list/list' });
    }, 500);
  },

  toggleFold: function () {
    this.setData({ foldOpen: !this.data.foldOpen });
  },

  onCancel: function () {
    this.setData({ draft: null, input: '', amount: '', item: '', jsonText: '', confText: '', warnings: [], foldOpen: false });
    wx.showToast({ title: '已放弃这笔，台账没变', icon: 'none' });
  }
});
