/**
 * 云端接口封装（统一入口，页面不要直接 wx.cloud.callFunction）
 *
 * 约定（与 cloudfunctions/ 保持一致）：
 *   调用：callFunction({ name: 'room', data: { action: 'create', payload: { name } } })
 *   成功：{ ok: true,  data: 任意 }
 *   失败：{ ok: false, code: 'NO_AUTH' | 'NOT_MEMBER' | 'ROOM_NOT_FOUND' | 'ROOM_FULL'
 *                        | 'INVALID' | 'QUOTA' | 'INTERNAL', message: '中文提示' }
 *
 * 这一层只做三件事：拼参数、把 {ok:false} 变成可 catch 的错误、网络异常归一化。
 * 业务规则（谁能做什么、金额怎么算）全部在云函数里。
 */
const env = require('../config/env.js');

/** 统一的接口错误：页面里用 e.code 判断，用 e.message 直接提示用户 */
function ApiError(code, message) {
  this.name = 'ApiError';
  this.code = code;
  this.message = message || '操作失败';
}
ApiError.prototype = Object.create(Error.prototype);
ApiError.prototype.constructor = ApiError;

function isReady() {
  return env.cloudEnabled;
}

/**
 * @param {string} name 云函数名：login / room / expense / ai
 * @param {string} action 动作名
 * @param {object} [payload]
 * @returns {Promise<any>} 成功时直接 resolve data
 */
function call(name, action, payload) {
  return new Promise(function (resolve, reject) {
    if (!env.cloudEnabled) {
      reject(new ApiError('CLOUD_OFFLINE', '还没接入云端（请先在 config/env.js 填云环境 ID）'));
      return;
    }
    wx.cloud.callFunction({
      name: name,
      data: { action: action, payload: payload || {} }
    }).then(function (res) {
      const r = (res && res.result) || {};
      if (r.ok) {
        resolve(r.data);
        return;
      }
      reject(new ApiError(r.code || 'INTERNAL', r.message || '操作失败'));
    }).catch(function (err) {
      const msg = (err && err.errMsg) || (err && err.message) || '';
      if (/timeout|超时/i.test(msg)) {
        reject(new ApiError('TIMEOUT', '网络有点慢，请稍后重试'));
        return;
      }
      if (/cloud function.*not found|FUNCTION_NOT_FOUND/i.test(msg)) {
        reject(new ApiError('NOT_DEPLOYED', '云函数还没部署（' + name + '）'));
        return;
      }
      // 开发/体验阶段把原始错误带出来（一般是"函数执行出错"，多数是云端没装依赖），
      // 正式版只给一句人话，避免把内部信息暴露给用户
      console.error('[cloud]', name + '.' + action, msg);
      const brief = String(msg).slice(0, 140);
      reject(new ApiError('NETWORK', env.showDevTools && brief ? '调用失败：' + brief : '网络异常，请检查后重试'));
    });
  });
}

const api = {
  ApiError: ApiError,
  isReady: isReady,

  /**
   * 云函数连通性自检（部署排查用）
   * 用一个不存在的 action 去敲门：
   *   - 返回业务错误（INVALID）→ 函数在，只是这个 action 不存在 → ok
   *   - NOT_DEPLOYED           → 函数没上传到当前环境 → missing
   *   - NETWORK / TIMEOUT      → 网络问题 → error
   * @returns {Promise<'ok'|'missing'|'error'>}
   */
  ping: function (name) {
    return call(name, '__ping', {}).then(function () {
      return 'ok';
    }).catch(function (e) {
      const code = (e && e.code) || '';
      if (code === 'NOT_DEPLOYED') return 'missing';
      if (code === 'NETWORK' || code === 'TIMEOUT') return 'error';
      return 'ok';
    });
  },

  /**
   * 通用云存储上传
   * @param {string} cloudPath 云存储路径，形如 avatars/xxx.jpg
   * @param {string} filePath  本地临时文件路径
   */
  upload: function (cloudPath, filePath) {
    return new Promise(function (resolve, reject) {
      if (!env.cloudEnabled) {
        reject(new ApiError('CLOUD_OFFLINE', '还没接入云端（请先在 config/env.js 填云环境 ID）'));
        return;
      }
      wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: filePath })
        .then(function (res) { resolve(res.fileID); })
        .catch(function () { reject(new ApiError('UPLOAD_FAIL', '文件上传失败，请检查网络后重试')); });
    });
  },

  login: {
    /** 我是谁：openid、当前房间、昵称头像 */
    whoami: function () { return call('login', 'whoami'); },
    /** 把本机账本迁移到云端（新用户首次进入时可选） */
    importLocal: function (payload) { return call('login', 'importLocal', payload || {}); }
  },

  room: {
    /** @param {string} roomName 房间名（2–16 字） @param {string} memberName 我在这个房间里的名字 */
    create: function (roomName, memberName) {
      return call('room', 'create', { name: roomName, memberName: memberName || '' });
    },
    join: function (code, name) { return call('room', 'join', { code: code, name: name || '' }); },
    leave: function () { return call('room', 'leave'); },
    rename: function (name) { return call('room', 'rename', { name: name }); },
    dissolve: function () { return call('room', 'dissolve'); },
    members: function () { return call('room', 'members'); },
    /** 房主预留一个成员位（对方用同名加入时认领） */
    addMember: function (name) { return call('room', 'addMember', { name: name }); },
    /** 房主移除成员（软删除，历史账目保留） */
    removeMember: function (name) { return call('room', 'removeMember', { name: name }); },
    resetCode: function () { return call('room', 'resetCode'); },
    summary: function () { return call('room', 'summary'); },
    /**
     * 昵称/头像。name 传空串会被当成"要改名成空"而被服务端拒绝，
     * 所以只改头像时不要传 name（这里按需拼 payload）。
     */
    updateProfile: function (name, avatarFileID) {
      const payload = {};
      if (name !== undefined && name !== null && String(name).trim() !== '') payload.name = String(name).trim();
      if (avatarFileID) payload.avatarFileID = avatarFileID;
      return call('room', 'updateProfile', payload);
    },
    /** 上传头像（云存储 avatars/）并写回成员资料 */
    uploadAvatar: function (filePath) {
      const ext = /\.png$/i.test(filePath) ? 'png' : 'jpg';
      const cloudPath = 'avatars/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
      return api.upload(cloudPath, filePath);
    }
  },

  expense: {
    add: function (record) { return call('expense', 'add', record); },
    update: function (expenseId, patch) { return call('expense', 'update', { expenseId: expenseId, patch: patch }); },
    revoke: function (expenseId) { return call('expense', 'revoke', { expenseId: expenseId }); },
    settle: function (expenseId, from, to, amount) {
      return call('expense', 'settle', { expenseId: expenseId, from: from, to: to, amount: amount });
    },
    unsettle: function (expenseId, from, to) {
      return call('expense', 'unsettle', { expenseId: expenseId, from: from, to: to });
    },
    /** cursor 为 null 取第一页；filter: 'all' | 'open' */
    list: function (opt) {
      const o = opt || {};
      return call('expense', 'list', { cursor: o.cursor || null, limit: o.limit || 30, month: o.month || '', filter: o.filter || 'all' });
    },
    /** 结清流水：不传 expenseId 就是整个房间最近 50 条 */
    logs: function (expenseId) { return call('expense', 'logs', { expenseId: expenseId || '' }); },
    /** 首页/月报聚合（总额、人均、待结清、最近 5 笔、每个人的净额） */
    summary: function () { return call('expense', 'summary'); }
  },

  ai: {
    /**
     * 把小票图片传到云存储 `ai-temp/`（云函数识图成功后会删掉，不留存）。
     * 注意：路径前缀必须是 ai-temp/，云端只清理这个目录，见 cloudfunctions/README.md。
     * @returns {Promise<string>} fileID
     */
    upload: function (filePath) {
      const ext = /\.png$/i.test(filePath) ? 'png' : 'jpg';
      const cloudPath = 'ai-temp/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
      return api.upload(cloudPath, filePath);
    },
    /** 小票识图：先 upload() 拿 fileID，再交给云函数代理调用模型 */
    recognize: function (fileID, mime) { return call('ai', 'recognize', { fileID: fileID, mime: mime || 'image/jpeg' }); }
  }
};

module.exports = api;
