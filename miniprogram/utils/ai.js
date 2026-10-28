/**
 * 小票识图（云端代理版）
 *
 * 为什么改成这样：
 *   以前是小程序直接拿用户填的 API Key 去请求 DeepSeek——Key 在客户端、域名要备案，
 *   上线既不合规也不安全。现在改成：图片上传到云存储 ai-temp/ → 云函数带 Key 调模型 →
 *   返回归一化结果 → 云函数把临时图片删掉（不留存）。
 *
 * 依赖：云函数 ai 已部署，且环境变量里配好 DEEPSEEK_KEY（见 cloudfunctions/README.md）。
 */
const api = require('./api.js');

/**
 * @param {string} imagePath 本地图片临时路径（wx.chooseMedia 拿到的）
 * @returns {Promise<{merchant,date,total,sum,lines,warnings,raw,provider}>}
 */
function recognize(imagePath) {
  if (!api.isReady()) {
    return Promise.reject(new Error('还没接入云端：暂时不能识图，可以把票面文字粘到下面的输入框'));
  }
  return api.ai.upload(imagePath).then(function (fileID) {
    return api.ai.recognize(fileID, 'image/jpeg');
  }).then(function (rec) {
    const out = rec || {};
    out.provider = out.provider || '云端 AI 识图';
    return out;
  });
}

module.exports = { recognize };
