/**
 * 自定义导航栏尺寸计算
 *
 * 首页用了 "navigationStyle": "custom"，微信不会自动给顶部留状态栏，
 * 右上角还有一颗系统胶囊（··· ⊙）无法被页面覆盖。所以必须自己算出：
 *   - statusBarHeight   状态栏高度（px），整块头部要往下让这么多
 *   - navBarHeight      与胶囊同一行的高度（px），保证品牌区垂直居中、不挤
 *   - capsuleReserve    右侧要给胶囊留出的宽度（px），否则标题会被胶囊压住
 *
 * 单位一律用 px（内联 style 用 px，rpx 在 inline 里不换算）。
 */

let cache = null;

function pos(n, dflt) {
  const v = Number(n);
  return isFinite(v) && v > 0 ? Math.round(v) : dflt;
}

function readWindow() {
  let info = {};
  try {
    if (typeof wx.getWindowInfo === 'function') info = wx.getWindowInfo() || {};
    else if (typeof wx.getSystemInfoSync === 'function') info = wx.getSystemInfoSync() || {};
  } catch (e) {
    info = {};
  }
  return info || {};
}

function readCapsule() {
  try {
    if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
      const r = wx.getMenuButtonBoundingClientRect() || {};
      // 部分老基础库 / 平板模拟器会返回全 0，这种情况按默认值兜底
      if (pos(r.width, 0) > 0 && pos(r.height, 0) > 0 && pos(r.left, 0) > 0) return r;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function measure() {
  const win = readWindow();
  const statusBarHeight = pos(win.statusBarHeight, 20);
  const windowWidth = pos(win.windowWidth, 375);
  const windowHeight = pos(win.windowHeight, 667);

  let safeBottom = 0;
  const safe = win.safeArea;
  if (safe && pos(safe.bottom, 0) > 0) {
    safeBottom = Math.max(0, Math.round(windowHeight - safe.bottom));
  }

  const cap = readCapsule();
  let navBarHeight;
  let capsuleReserve;
  if (cap) {
    // 胶囊上下留白对称：navBarHeight = (胶囊顶 - 状态栏) * 2 + 胶囊高
    navBarHeight = Math.max(32, Math.round((cap.top - statusBarHeight) * 2 + cap.height));
    // 胶囊左边缘到屏幕右侧的宽度 + 8px 呼吸缝
    capsuleReserve = Math.max(0, Math.round(windowWidth - cap.left + 8));
  } else {
    navBarHeight = 44;
    capsuleReserve = 104;
  }

  return {
    statusBarHeight: statusBarHeight,
    navBarHeight: navBarHeight,
    capsuleReserve: capsuleReserve,
    safeBottom: safeBottom,
    windowWidth: windowWidth
  };
}

function getNavMetrics() {
  if (!cache) cache = measure();
  return cache;
}

function resetNavMetrics() {
  cache = null;
}

module.exports = {
  getNavMetrics: getNavMetrics,
  resetNavMetrics: resetNavMetrics
};
