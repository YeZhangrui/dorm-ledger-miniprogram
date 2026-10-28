const F = require('../../utils/finance.js');
const store = require('../../utils/store.js');
const ai = require('../../utils/ai.js');
const api = require('../../utils/api.js');

Page({
  data: {
    aiOpen: false,
    presetLabels: [],
    presetOptions: [],
    presetIndex: 0,
    aiBase: '',
    aiModel: '',
    aiKey: '',
    aiJsonMode: false,
    aiState: '',
    imagePath: '',
    loading: false,
    text: '',
    draft: null,
    merchant: '',
    dateText: '',
    sumText: '¥0.00',
    totalText: '¥0.00',
    provider: '',
    warnings: [],
    lines: [],
    rawText: '',
    memberNames: [],
    payerIndex: 0,
    payerOptions: [],
    parts: [],
    foldOpen: false,
    // 多行 placeholder 只能由数据注入：WXML 属性里的 &#10; 不会变成换行
    phText: '好邻居便利店\n日期：2026-10-14\n桶装水 12.40\n垃圾袋 8.90\n合计 21.30'
  },

  onShow: function () {
    const that = this;
    store.loadThen(function () { that.boot(); });
  },

  boot: function () {
    const s = store.getState();
    const labels = F.AI_PRESET_KEYS.map(function (k) { return F.AI_PRESETS[k].label; });
    let presetIndex = F.AI_PRESET_KEYS.indexOf(s.ai.preset);
    if (presetIndex < 0) presetIndex = 0;
    this.setData({
      presetLabels: labels,
      presetOptions: labels.map(function (l) { return { label: l }; }),
      presetIndex: presetIndex,
      aiBase: s.ai.base,
      aiModel: s.ai.model,
      aiKey: s.ai.key,
      aiJsonMode: !!s.ai.jsonMode,
      aiState: this.aiStateText(s.ai),
      memberNames: s.members
    });
  },

  aiStateText: function (cfg) {
    if (!cfg || !cfg.base || !cfg.model) return '还没配置：识图会退回“粘贴票面文字”';
    return '当前：' + cfg.model + ' @ ' + cfg.base + (cfg.key ? '（已填 Key）' : '');
  },

  toggleAi: function () {
    this.setData({ aiOpen: !this.data.aiOpen });
  },

  toggleFold: function () {
    this.setData({ foldOpen: !this.data.foldOpen });
  },

  onPreset: function (e) {
    const i = Number(e.detail.index);
    const preset = F.AI_PRESETS[F.AI_PRESET_KEYS[i]];
    this.setData({ presetIndex: i, aiBase: preset.base, aiModel: preset.model });
  },

  onBase: function (e) { this.setData({ aiBase: e.detail.value }); },
  onModel: function (e) { this.setData({ aiModel: e.detail.value }); },
  onKey: function (e) { this.setData({ aiKey: e.detail.value }); },
  onJsonMode: function (e) { this.setData({ aiJsonMode: e.detail.value }); },

  saveAi: function () {
    const d = this.data;
    const preset = F.AI_PRESET_KEYS[d.presetIndex];
    const cfg = {
      preset: preset,
      base: String(d.aiBase || '').trim(),
      model: String(d.aiModel || '').trim(),
      key: String(d.aiKey || '').trim(),
      jsonMode: !!d.aiJsonMode
    };
    if (!cfg.base || !cfg.model) {
      wx.showToast({ title: '接口和模型不能为空', icon: 'none' });
      return;
    }
    store.saveAi(cfg);
    this.setData({ aiState: this.aiStateText(cfg) });
    wx.showToast({ title: '已保存到本机', icon: 'success' });
  },

  clearAi: function () {
    const preset = F.AI_PRESETS.deepseek;
    const cfg = { preset: 'deepseek', base: preset.base, model: preset.model, key: '', jsonMode: false };
    store.saveAi(cfg);
    this.setData({ aiBase: cfg.base, aiModel: cfg.model, aiKey: '', aiJsonMode: false, aiState: this.aiStateText(cfg) });
    wx.showToast({ title: '已清除 AI 配置', icon: 'none' });
  },

  chooseImage: function () {
    const that = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        that.setData({ imagePath: file.tempFilePath });
      }
    });
  },

  previewImage: function () {
    if (!this.data.imagePath) return;
    wx.previewImage({ urls: [this.data.imagePath], current: this.data.imagePath });
  },

  onText: function (e) {
    this.setData({ text: e.detail.value });
  },

  recognize: function () {
    const s = store.getState();
    const d = this.data;
    if (d.imagePath && api.isReady()) {
      this.runAi();
      return;
    }
    if (!String(d.text || '').trim()) {
      wx.showToast({
        title: d.imagePath ? '没配 AI 时读不了图，请把票面文字粘到下面' : '先选一张小票照片，或把票面文字粘到下面',
        icon: 'none'
      });
      return;
    }
    const parsed = F.parseReceiptText(d.text);
    this.applyDraft(parsed, s);
  },

  /** 云端识图：上传到 ai-temp/ 后由云函数调模型，返回归一化结果 */
  runAi: function () {
    const that = this;
    that.setData({ loading: true });
    ai.recognize(that.data.imagePath).then(function (parsed) {
      that.setData({ loading: false });
      that.applyDraft(parsed, store.getState());
    }).catch(function (err) {
      that.setData({ loading: false });
      wx.showModal({
        title: 'AI 识图失败',
        content: String((err && err.message) || err) + '\n\n没配好也可以把票面文字粘到下面，一样能识别。',
        showCancel: false
      });
    });
  },

  applyDraft: function (parsed, s) {
    const lines = (parsed.lines || []).map(function (l, i) {
      return { id: i, name: l.name, amountText: F.plain(l.amount), use: true, low: l.conf < 0.8 };
    });
    const parts = s.members.map(function (m) { return { name: m, on: true }; });
    if (!parsed.lines || !parsed.lines.length) {
      wx.showToast({ title: (parsed.warnings && parsed.warnings[0]) || '没解析出明细行', icon: 'none' });
    }
    this.setData({
      draft: parsed,
      merchant: parsed.merchant,
      dateText: parsed.date,
      sumText: F.fmt(parsed.sum),
      totalText: F.fmt(parsed.total),
      provider: parsed.provider || '',
      warnings: parsed.warnings || [],
      lines: lines,
      rawText: parsed.raw || '',
      memberNames: s.members,
      payerOptions: s.members.map(function (m) { return { label: m }; }),
      payerIndex: Math.max(0, s.members.indexOf(s.me)),
      parts: parts,
      foldOpen: false
    });
  },

  toggleLine: function (e) {
    const i = Number(e.currentTarget.dataset.i);
    const lines = this.data.lines.slice();
    lines[i] = Object.assign({}, lines[i], { use: !lines[i].use });
    this.setData({ lines: lines });
  },

  onLineName: function (e) {
    const i = Number(e.currentTarget.dataset.i);
    const lines = this.data.lines.slice();
    lines[i] = Object.assign({}, lines[i], { name: e.detail.value });
    this.setData({ lines: lines });
  },

  onLineAmount: function (e) {
    const i = Number(e.currentTarget.dataset.i);
    const lines = this.data.lines.slice();
    lines[i] = Object.assign({}, lines[i], { amountText: e.detail.value });
    this.setData({ lines: lines });
  },

  togglePart: function (e) {
    const i = Number(e.currentTarget.dataset.i);
    const parts = this.data.parts.slice();
    const onCount = parts.filter(function (p) { return p.on; }).length;
    if (parts[i].on && onCount <= 1) {
      wx.showToast({ title: '至少留一个人参与', icon: 'none' });
      return;
    }
    parts[i] = Object.assign({}, parts[i], { on: !parts[i].on });
    this.setData({ parts: parts });
  },

  onPayer: function (e) {
    this.setData({ payerIndex: Number(e.detail.index) });
  },

  /** 票面日期识别错时可以手改，避免记到别的月份 */
  onDate: function (e) {
    const v = String(e.detail.value || '').slice(0, 10);
    if (v) this.setData({ dateText: v });
  },

  confirm: function (mode) {
    const d = this.data;
    if (!d.draft) {
      wx.showToast({ title: '先识别一张小票', icon: 'none' });
      return;
    }
    const picked = [];
    d.lines.forEach(function (l) {
      const amt = F.num(parseFloat(l.amountText) || 0);
      if (l.use && amt > 0) picked.push({ name: String(l.name || '').trim() || '未识别项目', amount: amt });
    });
    if (!picked.length) {
      wx.showToast({ title: '至少留一行明细', icon: 'none' });
      return;
    }
    const payer = d.memberNames[d.payerIndex] || d.memberNames[0];
    const participantNames = d.parts.filter(function (p) { return p.on; }).map(function (p) { return p.name; });
    if (!participantNames.length) {
      wx.showToast({ title: '至少留一个参与人', icon: 'none' });
      return;
    }
    if (participantNames.indexOf(payer) < 0) participantNames.push(payer);

    const merchant = String(d.merchant || '小票');
    const dateText = d.dateText || F.todayStr();
    const receiptMeta = {
      merchant: merchant,
      date: dateText,
      total: F.num(d.draft.total),
      provider: d.provider || '手动粘贴的票面文字',
      lines: picked
    };

    const records = [];
    if (mode === 'merge') {
      const amount = F.num(picked.reduce(function (a, l) { return a + l.amount; }, 0));
      let cat = F.guessCategory(picked.map(function (l) { return l.name; }).join(' '));
      if (cat === '其他') cat = '日用品';
      records.push(store.buildExpense({
        date: dateText,
        amount: amount,
        item: merchant + '（' + picked.length + ' 项）',
        category: cat,
        payer: payer,
        participants: participantNames,
        source: 'receipt',
        receipt: receiptMeta,
        raw: '小票识别：' + merchant
      }));
    } else {
      picked.forEach(function (l) {
        records.push(store.buildExpense({
          date: dateText,
          amount: l.amount,
          item: l.name,
          category: F.guessCategory(l.name),
          payer: payer,
          participants: participantNames,
          source: 'receipt',
          receipt: Object.assign({}, receiptMeta, { lines: [l] }),
          raw: '小票识别：' + merchant + ' ' + l.name
        }));
      });
    }

    store.mutate(function (s) {
      // 倒序插入，保证明细列表里保持票面顺序
      records.slice().reverse().forEach(function (r) { s.expenses.unshift(r); });
    });

    this.setData({ draft: null, lines: [], warnings: [], imagePath: '', text: '', rawText: '', merchant: '', dateText: '', provider: '', foldOpen: false });
    wx.showToast({
      title: (mode === 'merge' ? '已合并入账 ' : '已逐条入账 ') + records.length + ' 笔',
      icon: 'success'
    });
    setTimeout(function () {
      wx.switchTab({ url: '/pages/list/list' });
    }, 600);
  },

  onMerge: function () {
    this.confirm('merge');
  },

  onEach: function () {
    this.confirm('each');
  },

  cancelDraft: function () {
    this.setData({ draft: null, lines: [], warnings: [], imagePath: '', text: '', rawText: '', merchant: '', dateText: '', provider: '', foldOpen: false });
    wx.showToast({ title: '已放弃这张小票', icon: 'none' });
  }
});
