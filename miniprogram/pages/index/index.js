const F = require('../../utils/finance.js');
const store = require('../../utils/store.js');
const layout = require('../../utils/layout.js');
const env = require('../../config/env.js');
const api = require('../../utils/api.js');
const user = require('../../utils/user.js');

const HERO_KEY = 'dorm-hero-compact-v1';

Page({
  data: {
    // 自定义导航栏的安全尺寸（px），onLoad 时按真机/模拟器重新测量
    nav: { statusBarHeight: 20, navBarHeight: 44, capsuleReserve: 104 },
    // 正式版隐藏「演示数据 / 清空」这类开发入口（见 config/env.js）
    showDevTools: env.showDevTools && !env.cloudLedger,
    compact: false,
    dormText: '',
    statusText: '',
    roomText: '',
    heroTotal: '¥0.00',
    heroSub: '人均 ¥0.00 · 0 笔',
    heroMini: '本月 ¥0.00',
    alertTotal: '',
    alertItems: 0,
    showAlert: false,
    unsettledCountText: '',
    people: [],
    settle: [],
    recent: [],
    hasOpen: false
  },

  onLoad: function () {
    this.syncNav();
    const that = this;
    // 横竖屏切换 / 折叠屏展开时重新量一次，避免头部又压到状态栏
    if (typeof wx.onWindowResize === 'function') {
      this._onResize = function () {
        layout.resetNavMetrics();
        that.syncNav();
      };
      wx.onWindowResize(this._onResize);
    }
  },

  onUnload: function () {
    if (this._onResize && typeof wx.offWindowResize === 'function') {
      wx.offWindowResize(this._onResize);
    }
  },

  syncNav: function () {
    const m = layout.getNavMetrics();
    this.setData({
      nav: {
        statusBarHeight: m.statusBarHeight,
        navBarHeight: m.navBarHeight,
        capsuleReserve: m.capsuleReserve
      }
    });
  },

  /** 分享给室友：卡片直接带房间码，对方点开就是"加入这个房间" */
  onShareAppMessage: function () {
    const r = user.currentRoom();
    return {
      title: r ? '加入我的寝室账本（房间码 ' + r.code + '）' : '寝账 · 寝室公共开支记账',
      path: r ? '/pages/onboarding/onboarding?code=' + r.code : '/pages/index/index'
    };
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
    this.guardCloud();
    this.bootHero();
    store.loadThen(function () { that.refresh(); });
  },

  /**
   * 云端引导：只在"接了云 + 明确没有房间 + 用户没选过先不联网"时跳到 onboarding。
   * 断网/云函数没部署时 refresh() 会安静返回 null，这里不拦人，继续用本机账本。
   */
  guardCloud: function () {
    const that = this;
    if (!api.isReady()) return;
    if (user.needsOnboarding()) {
      this.toOnboarding();
      return;
    }
    user.refresh().then(function (u) {
      if (u && !u.room && !user.isSkipCloud()) that.toOnboarding();
    });
  },

  toOnboarding: function () {
    if (this._toOnboarding) return; // 防止 onShow 连点/重复跳转
    this._toOnboarding = true;
    wx.reLaunch({ url: '/pages/onboarding/onboarding' });
  },

  bootHero: function () {
    let compact;
    try {
      const v = wx.getStorageSync(HERO_KEY);
      compact = v === '1' ? true : v === '0' ? false : false;
    } catch (e) {
      compact = false;
    }
    this.setData({ compact: compact });
  },

  toggleHero: function () {
    const compact = !this.data.compact;
    this.setData({ compact: compact });
    try { wx.setStorageSync(HERO_KEY, compact ? '1' : '0'); } catch (e) { /* ignore */ }
    this.refresh();
  },

  refresh: function () {
    const s = store.getState();
    const list = s.expenses.slice().sort(function (a, b) {
      return (b.date + b.id) < (a.date + a.id) ? -1 : 1;
    });
    const mk = F.monthKey();
    // 只统计本月：以前"本月没记录就回落到全部"会让标题写着"本月"、数字却是全部，属于假口径
    const use = list.filter(function (e) { return (e.date || '').slice(0, 7) === mk; });
    const total = F.num(use.reduce(function (a, e) { return a + F.num(e.amount); }, 0));
    const N = s.members.length;
    const per = N ? F.num(total / N) : 0;

    const bals = F.balances(list, s.members);
    const people = bals.map(function (b) {
      return {
        name: b.name,
        ex: !!b.ex,
        cls: b.net >= 0 ? 'pos' : 'neg',
        txt: b.net === 0 ? '已平' : (b.net > 0 ? '+' + F.fmt(b.net) : '-' + F.fmt(Math.abs(b.net)))
      };
    });

    const open = F.unsettled(list);
    const items = F.unsettledItems(list);
    const totalOpen = F.num(open.reduce(function (a, o) { return a + o.amount; }, 0));
    const settle = open.map(function (o) {
      const detail = o.items.map(function (x) { return x.item + ' ' + F.fmt(x.amount); }).join(' · ');
      return {
        key: o.from + '->' + o.to,
        from: o.from,
        to: o.to,
        amountText: F.fmt(o.amount),
        detail: detail,
        offsetText: o.offset > 0 ? ('已自动对冲反向欠款 ' + F.fmt(o.offset) + '，实收 ' + F.fmt(o.amount)) : ''
      };
    });

    const recent = list.slice(0, 5).map(function (e) {
      const shares = e.shares || F.computeShares(e.amount, e.participants);
      const openN = F.unsettledItems([e]).length;
      // 只把结清状态做成标签；"小票"来源放进 meta 行，避免长项目名把标签挤到第二行
      const tags = [{ text: openN === 0 ? '已结清' : openN + ' 人未结', cls: openN === 0 ? 'ok' : 'no' }];
      const tail = shares.some(function (p) { return p.tail; });
      return {
        key: e.id,
        icon: F.categoryIcon(e.category),
        item: e.item,
        tags: tags,
        meta: e.date + ' · ' + e.payer + ' 垫付 · ' + shares.length + ' 人' +
          (e.mode === 'days' ? '（按天数）' : '') + ' · 人均 ' + F.fmt(shares.length ? shares[0].share : 0) +
          (e.source === 'receipt' ? ' · 🧾 小票' : ''),
        amountText: F.fmt(e.amount),
        tail: tail
      };
    });

    this.setData({
      dormText: N + ' 人寝室' + (this.data.compact ? '' : ' · 公共开支台账'),
      statusText: '当前记账人：' + s.me,
      roomText: s.room ? s.room.code : '—',
      heroTotal: F.fmt(total),
      heroSub: '人均 ' + F.fmt(per) + ' · ' + use.length + ' 笔 · ' + N + ' 人',
      heroMini: '本月 ' + F.fmt(total) + ' · 人均 ' + F.fmt(per) + ' · ' + use.length + ' 笔',
      showAlert: totalOpen > 0,
      alertTotal: F.fmt(totalOpen),
      alertItems: items.length,
      unsettledCountText: open.length ? open.length + ' 组待结清（已抵消）' : '已全部结清',
      people: people,
      settle: settle,
      recent: recent,
      hasOpen: open.length > 0
    });
  },

  goRoom: function () {
    wx.navigateTo({ url: '/pages/room/room' });
  },

  goMembers: function () {
    wx.navigateTo({ url: '/pages/members/members' });
  },

  goBook: function () {
    wx.switchTab({ url: '/pages/book/book' });
  },

  goList: function () {
    wx.switchTab({ url: '/pages/list/list' });
  },

  goRemind: function () {
    wx.switchTab({ url: '/pages/remind/remind' });
  },

  onSettle: function (e) {
    const from = e.currentTarget.dataset.from;
    const to = e.currentTarget.dataset.to;
    const that = this;
    wx.showModal({
      title: '标记已结清',
      content: from + ' → ' + to + '：确认这笔已经还清？',
      confirmText: '已结清',
      success: function (res) {
        if (!res.confirm) return;
        store.mutate(function (st) {
          st.expenses = F.settlePair(st.expenses, from, to);
        });
        that.refresh();
        wx.showToast({ title: '已结清', icon: 'success' });
      }
    });
  },

  onSeed: function () {
    const that = this;
    wx.showModal({
      title: '重新生成演示数据',
      content: '会用当前成员重刷一整套 6 笔演示账目，并覆盖本房间现有账目。',
      confirmText: '生成',
      success: function (res) {
        if (!res.confirm) return;
        store.reseed();
        that.refresh();
        wx.showToast({ title: '已生成演示数据', icon: 'success' });
      }
    });
  },

  onReset: function () {
    const that = this;
    wx.showModal({
      title: '清空账目',
      content: '只清空本房间的账目，成员设置保留。清空后不可恢复。',
      confirmText: '清空',
      confirmColor: '#a33a3a',
      success: function (res) {
        if (!res.confirm) return;
        store.clearExpenses();
        that.refresh();
        wx.showToast({ title: '已清空', icon: 'none' });
      }
    });
  }
});
