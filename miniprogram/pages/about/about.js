const env = require('../../config/env.js');

Page({
  data: {
    version: '2.0.0',
    contact: '点击下方按钮可直接联系开发者'
  },

  onLoad: function () {
    try {
      const info = wx.getAccountInfoSync();
      const v = info && info.miniProgram && info.miniProgram.version;
      if (v) this.setData({ version: v });
    } catch (e) {
      /* 取不到就用默认版本号 */
    }
  }
});
