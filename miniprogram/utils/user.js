/**
 * 用户身份（openid / 昵称 / 当前房间）
 *
 * 为什么要单独一层：
 *   小程序没有"登录"这个概念，身份由云函数里的 OPENID 决定；客户端只需要把
 *   login.whoami 的结果缓存起来，用来判断"该不该进引导页""我现在在哪个房间"。
 *
 * 缓存键：dormledger_user_v1
 *   形如 { openid, room: {id, code, name, role} | null, profile: {name, avatarFileID}, at }
 *
 * 注意：
 *   - 只有云端可用（api.isReady()）时才需要身份；纯本机模式下永远返回"不需要引导"。
 *   - whoami 失败（断网/云函数没部署）时**不拦人**，安静地按本机模式继续，避免白屏。
 */
const api = require('./api.js');

const CACHE_KEY = 'dormledger_user_v1';
const SKIP_KEY = 'dormledger_skip_cloud_v1';
const CACHE_TTL = 7 * 24 * 3600 * 1000; // 7 天内直接用缓存，省一次云调用

function read() {
  try {
    const v = wx.getStorageSync(CACHE_KEY);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

function write(user) {
  try {
    wx.setStorageSync(CACHE_KEY, user);
  } catch (e) {
    /* 存不下不影响主流程 */
  }
}

function clear() {
  try {
    wx.removeStorageSync(CACHE_KEY);
  } catch (e) {
    /* ignore */
  }
}

function get() {
  return read();
}

/** 当前房间（没登录/没加入房间时返回 null） */
function currentRoom() {
  const u = read();
  return (u && u.room) || null;
}

/** 用户主动选择"先不联网，继续用本机" —— 记住这个选择，别再反复弹引导页 */
function setSkipCloud(skip) {
  try {
    if (skip) wx.setStorageSync(SKIP_KEY, '1');
    else wx.removeStorageSync(SKIP_KEY);
  } catch (e) {
    /* ignore */
  }
}

function isSkipCloud() {
  try {
    return wx.getStorageSync(SKIP_KEY) === '1';
  } catch (e) {
    return false;
  }
}

/**
 * 是否应该把用户引导到 onboarding：
 *   - 云端不可用 / 用户选了"先不联网" → 否
 *   - 有房间 → 否
 *   - 没有任何缓存 → 否（首次进入时由 refresh() 决定，避免断网就卡死在引导页）
 *   - 缓存里明确 room 为 null → 是
 */
function needsOnboarding() {
  if (!api.isReady()) return false;
  if (isSkipCloud()) return false;
  const u = read();
  if (!u) return false;
  return !u.room;
}

/**
 * 拉一次云端身份并写缓存。
 * @param {boolean} force 忽略 TTL 强制刷新
 * @returns {Promise<object|null>} 失败时 resolve(null)，不 reject，调用方不用 try/catch
 */
function refresh(force) {
  if (!api.isReady()) return Promise.resolve(null);
  const cached = read();
  if (!force && cached && cached.at && Date.now() - cached.at < CACHE_TTL) {
    return Promise.resolve(cached);
  }
  return api.login.whoami().then(function (data) {
    const user = {
      openid: (data && data.openid) || '',
      room: (data && data.room) || null,
      profile: (data && data.profile) || null,
      at: Date.now()
    };
    write(user);
    return user;
  }).catch(function () {
    return null;
  });
}

/** 建房/加入成功之后，把房间写进缓存（避免再多打一次 whoami） */
function setRoom(room, profile) {
  const u = read() || {};
  u.room = room || null;
  if (profile) u.profile = profile;
  u.at = Date.now();
  write(u);
  return u;
}

module.exports = {
  get: get,
  currentRoom: currentRoom,
  needsOnboarding: needsOnboarding,
  refresh: refresh,
  setRoom: setRoom,
  clear: clear,
  setSkipCloud: setSkipCloud,
  isSkipCloud: isSkipCloud
};
