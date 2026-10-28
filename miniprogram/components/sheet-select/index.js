/**
 * sheet-select：统一的「下拉选择」组件
 *
 * 为什么不用原生 <picker>：原生 selector 在小程序里会渲染成系统底部弹层
 * （取消/确定 + 灰色滚轮），样式完全不受页面控制，长文案还会挤成一行灰字，
 * 和界面上其它控件不是一套设计语言。这里自绘触发器 + 底部面板：
 *   - 触发器长得和输入框一致（白底、发丝描边、右侧 ⌄）
 *   - 面板是白色卡片 + 拖拽短横 + 每行「标题 / 说明 / 右侧金额」，选中项品牌绿描边 + ✓
 *   - 点行即选、点遮罩取消，不需要再点"确定"
 *
 * 用法：
 *   <sheet-select title="垫付人" options="{{payerOptions}}" index="{{payerIndex}}"
 *                 disabled="{{false}}" empty="暂无可选项" bind:change="onPayer" />
 *   options 支持字符串数组，或 [{ label, desc, side }]（desc/side 可选）
 *   change 事件 detail: { index, option }
 */
Component({
  options: {
    styleIsolation: 'apply-shared' // 允许继承 app.wxss 的全局排版，但外观样式仍以本组件为准
  },

  properties: {
    title: { type: String, value: '请选择' },
    placeholder: { type: String, value: '请选择' },
    options: { type: Array, value: [] },
    index: { type: Number, value: 0 },
    disabled: { type: Boolean, value: false },
    empty: { type: String, value: '暂无可选项' },
    sub: { type: String, value: '' }
  },

  data: {
    open: false,
    rows: [],
    cur: null
  },

  observers: {
    options: function (list) {
      const rows = (list || []).map(function (o, i) {
        if (o && typeof o === 'object') return Object.assign({ id: 'o' + i }, o);
        return { id: 'o' + i, label: String(o) };
      });
      this.setData({ rows: rows });
    },
    'rows, index': function (rows, index) {
      this.setData({ cur: (rows && rows[index]) || null });
    }
  },

  methods: {
    openPanel: function () {
      if (this.data.disabled) {
        wx.showToast({ title: this.data.empty, icon: 'none' });
        return;
      }
      if (!this.data.rows.length) {
        wx.showToast({ title: this.data.empty, icon: 'none' });
        return;
      }
      this.setData({ open: true });
    },

    closePanel: function () {
      this.setData({ open: false });
    },

    // 面板内的点击不要冒泡到遮罩，否则点内容也会关掉
    noop: function () {},

    pick: function (e) {
      const i = Number(e.currentTarget.dataset.i);
      const cur = this.data.rows[i];
      if (!cur) return;
      this.setData({ open: false });
      this.triggerEvent('change', { index: i, option: cur });
    }
  }
});
