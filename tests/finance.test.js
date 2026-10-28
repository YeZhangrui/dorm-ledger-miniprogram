'use strict';

/**
 * miniprogram/utils/finance.js 的回归测试（node:test，零第三方依赖）
 *
 * 跑法（在 D:\小组作业 下）：
 *   node --test tests\
 *   node --test tests\finance.test.js      （只跑本文件）
 *
 * 约定：
 *  1) 每个用例自己用工厂函数造夹具（members4 / people / makeExpense），用例之间不共享可变对象，
 *     所以单独跑、乱序跑、并行跑结果都一样；
 *  2) 金额一律断言到「分」：cents() 把元换成整数分再比较，避免 0.1 + 0.2 这种浮点噪音把用例弄红；
 *  3) 注释写的是「这条用例防的是什么回归」，改实现时先看注释再决定要不要改断言；
 *  4) 不读用户目录、不联网、不碰 wx.*，纯 Node 环境可跑。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 被测模块：纯函数、模块级只有常量，require 一次即可（无副作用）
const F = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'finance.js'));

/* ================================ 断言工具 ================================ */

/** 元 → 整数分。所有金额断言都走这里，浮点噪音不至于让用例变红，但差 1 分就必须红 */
function cents(yuan) {
  assert.equal(typeof yuan, 'number', '期望拿到数字金额，实际是 ' + typeof yuan + '：' + String(yuan));
  assert.ok(Number.isFinite(yuan), '金额不是有限数字：' + String(yuan));
  return Math.round(yuan * 100);
}

/** 断言每份都是「整分」：不能出现 3.3333、0.005 这种三级小数（展示层会 toFixed(2)，差的钱没人认领） */
function assertWholeCents(shares, label) {
  shares.forEach(function (s) {
    const c = s.share * 100;
    assert.ok(
      Math.abs(c - Math.round(c)) < 1e-6,
      label + '：' + s.name + ' 的份额 ' + s.share + ' 元不是整数分（折合 ' + c + ' 分）'
    );
  });
}

/** 断言「各份之和严格等于总额」——这是分摊逻辑最容易悄悄坏掉的硬约束 */
function assertSharesSumTo(shares, amount, label) {
  const got = shares.reduce(function (sum, s) { return sum + cents(s.share); }, 0);
  const want = cents(amount);
  assert.equal(
    got,
    want,
    label + '：各份之和 ' + got + ' 分 ≠ 总额 ' + want + ' 分；明细 ' +
      shares.map(function (s) { return s.name + '=' + s.share; }).join('、')
  );
}

/** 在 unsettled 结果里按方向找一条，找不到时给出整个列表方便排查 */
function findEntry(list, from, to) {
  const hit = list.filter(function (x) { return x.from === from && x.to === to; })[0];
  if (!hit) {
    assert.fail(
      '没找到 ' + from + ' → ' + to + ' 的待结清项；实际列表：' +
        list.map(function (x) { return x.from + '→' + x.to + ' ' + x.amount; }).join('，')
    );
  }
  return hit;
}

/* ================================ 夹具工厂 ================================ */

/** 每次返回新数组：parseExpense 只读 members，但夹具不共享对象是硬规矩 */
function members4() {
  return ['陈默', '李昊', '王雨', '赵小满'];
}

/** 造参与者：[{name}] */
function people(names) {
  return names.map(function (name) { return { name: name }; });
}

/** 造一条开支记录，只写用例关心的字段 */
function makeExpense(over) {
  const base = {
    id: 'e1',
    date: '2026-09-01',
    item: '测试开支',
    category: '其他',
    amount: 10,
    payer: '甲',
    participants: people(['甲', '乙']),
    mode: 'equal'
  };
  return Object.assign(base, over || {});
}

/**
 * 三笔账的标准夹具（balances / unsettled / settlePair 共用同一套数字，方便交叉验算）：
 *   e1：甲垫 30 元，甲乙丙 3 人均摊 → 每人 10 元
 *   e2：乙垫 6 元，甲乙 2 人均摊     → 每人 3 元
 * 毛额：乙欠甲 10、丙欠甲 10、甲欠乙 3；抵消后：乙欠甲 7、丙欠甲 10。
 */
function ledgerFixture() {
  return [
    makeExpense({ id: 'e1', item: '网费', category: '网费', amount: 30, payer: '甲', participants: people(['甲', '乙', '丙']) }),
    makeExpense({ id: 'e2', item: '电费', category: '电费', amount: 6, payer: '乙', participants: people(['甲', '乙']) })
  ];
}

/* ================================ computeShares ================================ */

test('computeShares：1 元 3 人等额分，得到 0.33 / 0.33 / 0.34，合计仍是 100 分', function () {
  const shares = F.computeShares(1, people(['A', 'B', 'C']));
  assert.equal(shares.length, 3, '3 个人应该拿到 3 份');
  assert.deepEqual(
    shares.map(function (s) { return cents(s.share); }),
    [33, 33, 34],
    '100 分 3 等分应为 33/33/34 分，实际 ' + shares.map(function (s) { return s.share + ' 元'; }).join(' / ')
  );
  assertSharesSumTo(shares, 1, '1 元 3 人等额分摊');
  assertWholeCents(shares, '1 元 3 人等额分摊');
  assert.deepEqual(
    shares.map(function (s) { return s.tail; }),
    [false, false, true],
    '尾差只能标在最后一份（吃尾差的人）上，标错会让页面「含尾差」提示指错人'
  );
});

test('computeShares：10 元 3 人等额分，得到 3.33 / 3.33 / 3.34，合计 10.00', function () {
  const shares = F.computeShares(10, people(['A', 'B', 'C']));
  assert.deepEqual(
    shares.map(function (s) { return cents(s.share); }),
    [333, 333, 334],
    '10 元 3 等分应为 3.33/3.33/3.34，实际 ' + shares.map(function (s) { return s.share; }).join(' / ')
  );
  assertSharesSumTo(shares, 10, '10 元 3 人等额分摊');
  assert.equal(shares.filter(function (s) { return s.tail; }).length, 1, '只允许一处尾差标记');
});

test('computeShares：0.01 元 8 人分，只出现 1 份 1 分钱，其余为 0，合计 0.01', function () {
  const shares = F.computeShares(0.01, people(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']));
  assert.deepEqual(
    shares.map(function (s) { return cents(s.share); }),
    [0, 0, 0, 0, 0, 0, 0, 1],
    '1 分钱分给 8 个人时，只能一个人拿到 1 分，实际 ' +
      shares.map(function (s) { return s.share; }).join(' / ')
  );
  assertSharesSumTo(shares, 0.01, '0.01 元 8 人分摊');
  assertWholeCents(shares, '0.01 元 8 人分摊'); // 防回归：不能出现 0.00125 / 0.005 这种半分级
  assert.equal(shares.filter(function (s) { return s.tail; }).length, 1, '尾差标记应只有一处');
});

test('computeShares：按权重（居住天数）1:3 分摊 100 元，得到 25 / 75 且权重被记录', function () {
  const shares = F.computeShares(100, [{ name: 'A', weight: 1 }, { name: 'B', weight: 3 }]);
  assert.deepEqual(
    shares.map(function (s) { return cents(s.share); }),
    [2500, 7500],
    '按 1:3 权重应是 25.00 / 75.00，实际 ' + shares.map(function (s) { return s.share; }).join(' / ')
  );
  assert.deepEqual(
    shares.map(function (s) { return s.weight; }),
    [1, 3],
    '权重必须写回明细，否则页面展示「按天数」时会显示成 1 天'
  );
  assertSharesSumTo(shares, 100, '100 元按 1:3 权重分摊');
});

test('computeShares：权重缺省或为 0 时按 1 人份算，9 元两人分不能出现 NaN', function () {
  const shares = F.computeShares(9, [{ name: 'A', weight: 0 }, { name: 'B' }]);
  assert.deepEqual(
    shares.map(function (s) { return cents(s.share); }),
    [450, 450],
    '权重非法时应退化成等额 4.50 / 4.50，实际 ' + shares.map(function (s) { return s.share; }).join(' / ')
  );
  assert.deepEqual(shares.map(function (s) { return s.weight; }), [1, 1], '非法权重在明细里要归一成 1');
  assertSharesSumTo(shares, 9, '9 元两人分的非法权重场景');
});

test('computeShares：金额带浮点尾巴时先收敛到分，9.155 元按 3 人分合计仍是 9.16', function () {
  const shares = F.computeShares(9.155, people(['A', 'B', 'C']));
  assert.deepEqual(
    shares.map(function (s) { return cents(s.share); }),
    [305, 305, 306],
    '9.155 应收敛成 9.16 再分（3.05/3.05/3.06），实际 ' + shares.map(function (s) { return s.share; }).join(' / ')
  );
  assertSharesSumTo(shares, 9.16, '9.155 元按 3 人分摊');
});

test('computeShares：没有参与人时返回空数组（下游 forEach 不会被炸）', function () {
  assert.deepEqual(F.computeShares(10, []), [], '空参与人应返回空数组');
  assert.deepEqual(F.computeShares(10, null), [], 'null 参与人应返回空数组');
});

test('computeShares：12 种金额 × 2~8 人的全组合，各份之和永远等于总额', function () {
  // 防的是「只在 100 分 3 人等额那一格对、换个金额就丢 1 分」这类回归
  const amounts = [0.01, 0.05, 0.1, 0.99, 1, 3.33, 7.77, 12.4, 86.4, 100, 355.2, 999.99];
  for (let n = 2; n <= 8; n++) {
    const names = [];
    for (let i = 0; i < n; i++) names.push('P' + (i + 1));
    amounts.forEach(function (amount) {
      const label = amount + ' 元 / ' + n + ' 人';
      const shares = F.computeShares(amount, people(names));
      assert.equal(shares.length, n, label + '：份数应等于人数');
      assertSharesSumTo(shares, amount, label);
      assertWholeCents(shares, label);
      // 尾差：最大余数法下可能有多份被补 1 分（如 0.02 元 / 4 人 → 后两人各 1 分），
      // 但不可能全员都补，且被补的那份一定为正
      const tails = shares.filter(function (s) { return s.tail; });
      assert.ok(tails.length <= n - 1, label + '：尾差标记最多 n−1 处，实际 ' + tails.length + ' 处');
      tails.forEach(function (s) {
        assert.ok(s.share > 0, label + '：被标记尾差的份额必须为正（' + s.name + ' = ' + s.share + '）');
      });
      shares.forEach(function (s) {
        assert.ok(s.share >= 0, label + '：' + s.name + ' 的份额为负（' + s.share + '）');
      });
    });
  }
});

test('computeShares：日常金额（≥1 元）× 2~8 人，不会出现负份额', function () {
  // 防的是「有人因为分摊反而倒欠钱」；小额角分级另见下面的已知缺陷用例
  const amounts = [1, 3.33, 12.4, 86.4, 100, 355.2, 999.99];
  for (let n = 2; n <= 8; n++) {
    const names = [];
    for (let i = 0; i < n; i++) names.push('P' + (i + 1));
    amounts.forEach(function (amount) {
      const shares = F.computeShares(amount, people(names));
      shares.forEach(function (s) {
        assert.ok(s.share >= 0, amount + ' 元 / ' + n + ' 人：' + s.name + ' 的份额为负（' + s.share + '）');
      });
    });
  }
});

test('computeShares：极小金额（0.01–2 元）× 2~8 人，都不出现负份额且合计精确', function (t) {
  // 回归用例：旧实现「每份四舍五入 + 最后一人吃尾差」在 0.05 元 / 7 人时会把最后一人算成 −0.01，
  // 于是 balances 里欠债人变正、unsettled 出现「G 欠 A ¥-0.01」、月报 openTotal 少 1 分。
  // 现改为最大余数法（整数分 + 余数按小数部分分配），本用例锁死该行为。
  const amounts = [0.01, 0.02, 0.03, 0.05, 0.09, 0.1, 0.5, 1, 2];
  let checked = 0;
  for (let n = 2; n <= 8; n++) {
    const names = [];
    for (let i = 0; i < n; i++) names.push('P' + (i + 1));
    amounts.forEach(function (amount) {
      const label = amount + ' 元 / ' + n + ' 人';
      const shares = F.computeShares(amount, people(names));
      assertSharesSumTo(shares, amount, label);
      assertWholeCents(shares, label);
      shares.forEach(function (s) {
        assert.ok(s.share >= 0, label + '：' + s.name + ' 的份额为负（' + s.share + '）');
      });
      checked++;
    });
  }
  t.diagnostic('已覆盖 ' + checked + ' 组小额组合');
});

test('computeShares：按 1:2:3 权重分摊 100 元，合计仍是 100 元', function () {
  const shares = F.computeShares(100, [
    { name: 'A', weight: 1 },
    { name: 'B', weight: 2 },
    { name: 'C', weight: 3 }
  ]);
  assertSharesSumTo(shares, 100, '100 元按 1:2:3 权重分摊');
  assertWholeCents(shares, '100 元按 1:2:3 权重分摊');
  assert.deepEqual(
    shares.map(function (s) { return cents(s.share); }),
    [1667, 3333, 5000],
    '应按权重 16.67 / 33.33 / 50.00，实际 ' + shares.map(function (s) { return s.share; }).join(' / ')
  );
});

/* ================================ ensureShares ================================ */

test('ensureShares：给缺 shares 的旧记录补齐，合计不变且不改动入参', function () {
  // 防的是老版本存下的记录（只有 participants 没有 shares）在升级后显示不出明细，
  // 或者补齐时顺手改坏了原数组（页面还拿着旧引用）
  const legacy = [makeExpense({ id: 'old', amount: 10, payer: 'A', participants: people(['A', 'B']) })];
  const snapshot = JSON.stringify(legacy);
  const filled = F.ensureShares(legacy);

  assert.equal(filled.length, 1, '条数不能变');
  assert.ok(filled[0] !== legacy[0], '补齐应返回新对象，不能就地改旧记录');
  assert.equal(JSON.stringify(legacy), snapshot, '入参必须原样不动，实际被改成了 ' + JSON.stringify(legacy));
  assertSharesSumTo(filled[0].shares, 10, '旧记录补齐 shares');
  assert.deepEqual(
    filled[0].shares.map(function (s) { return [s.name, cents(s.share)]; }),
    [['A', 500], ['B', 500]],
    '10 元两人分应补成 A=5.00、B=5.00'
  );
});

test('ensureShares：已有 shares 的记录原样保留，不能拿 participants 重算覆盖手工调整', function () {
  const adjusted = makeExpense({
    id: 'adj',
    amount: 10,
    payer: 'A',
    participants: people(['A', 'B']),
    shares: [
      { name: 'A', weight: 1, share: 9, tail: false },
      { name: 'B', weight: 1, share: 1, tail: true }
    ]
  });
  const out = F.ensureShares([adjusted]);
  assert.equal(out[0], adjusted, '有 shares 时应直接返回原对象（避免无谓拷贝）');
  assert.deepEqual(
    out[0].shares.map(function (s) { return cents(s.share); }),
    [900, 100],
    '手工改过的 9:1 不能被重算成 5:5'
  );
});

/* ================================ balances ================================ */

test('balances：3 人两笔账，净额合计为 0，垫付人为正、参与者为负', function () {
  const b = F.balances(ledgerFixture(), ['甲', '乙', '丙']);
  assert.deepEqual(
    b.map(function (x) { return x.name; }),
    ['甲', '乙', '丙'],
    '返回顺序应跟随 members，页面表格才不会跳行'
  );
  assert.deepEqual(
    b.map(function (x) { return [x.name, cents(x.paid), cents(x.owed), cents(x.net)]; }),
    [['甲', 3000, 1300, 1700], ['乙', 600, 1300, -700], ['丙', 0, 1000, -1000]],
    '甲垫 30 应承担 13 → +17；乙垫 6 应承担 13 → −7；丙应承担 10 → −10；实际 ' +
      JSON.stringify(b.map(function (x) { return [x.name, x.paid, x.owed, x.net]; }))
  );
  assert.equal(
    b.reduce(function (s, x) { return s + cents(x.net); }, 0),
    0,
    '所有人净额之和必须是 0，否则账本永远结不清'
  );
});

test('balances：已退出成员（不在 members 里）仍计入且标 ex，净额合计仍为 0', function () {
  // 防的是「成员退出后历史欠款凭空消失」；也防 ex 标记丢了自己那一份的净额
  const b = F.balances(ledgerFixture(), ['甲', '乙']);
  const byName = {};
  b.forEach(function (x) { byName[x.name] = x; });
  assert.deepEqual(Object.keys(byName), ['甲', '乙', '丙'], '已退出的丙必须仍出现在结果里');
  assert.equal(byName['丙'].ex, true, '不在 members 里的人应标 ex=true');
  assert.equal(cents(byName['丙'].owed), 1000, '丙仍欠 10.00 元');
  assert.equal(cents(byName['丙'].net), -1000, '丙的净额应为 −10.00 元');
  assert.equal(byName['甲'].ex, false, '在册成员 ex 应为 false');
  assert.equal(
    b.reduce(function (s, x) { return s + cents(x.net); }, 0),
    0,
    '含退出成员在内，净额合计仍必须为 0'
  );
});

test('balances：空账本时人人 0，不返回 null/undefined', function () {
  const b = F.balances([], ['甲']);
  assert.deepEqual(b, [{ name: '甲', paid: 0, owed: 0, net: 0, ex: false }], '空账本应给出全 0 记录');
});

/* ================================ unsettled / unsettledItems ================================ */

test('unsettled：乙欠甲 10、甲欠乙 3 先两两抵消，只报乙欠甲 7 且 offset 记 3', function () {
  const u = F.unsettled(ledgerFixture());
  assert.equal(u.length, 2, '抵消后应只剩 2 条（乙→甲、丙→甲），实际 ' + u.length + ' 条');
  assert.deepEqual(
    u.map(function (x) { return cents(x.amount); }),
    [1000, 700],
    '应按下欠金额从大到小排：丙→甲 10.00、乙→甲 7.00，实际 ' +
      u.map(function (x) { return x.from + '→' + x.to + ' ' + x.amount; }).join('，')
  );

  const bToJ = findEntry(u, '乙', '甲');
  assert.equal(cents(bToJ.offset), 300, '被抵消的反向欠款 3.00 应记在 offset（催缴话术要引用）');
  assert.deepEqual(
    bToJ.items.map(function (x) { return [x.item, cents(x.amount)]; }),
    [['网费', 1000]],
    '乙→甲 的明细应是网费 10.00，实际 ' + JSON.stringify(bToJ.items)
  );
  assert.deepEqual(
    (bToJ.offsetItems || []).map(function (x) { return [x.item, cents(x.amount)]; }),
    [['电费', 300]],
    '被抵消的 3.00 应保留原始明细，方便逐笔核对'
  );

  const cToJ = findEntry(u, '丙', '甲');
  assert.equal(cents(cToJ.offset), 0, '单向欠款 offset 应为 0');
  assert.equal(
    u.reduce(function (s, x) { return s + cents(x.amount); }, 0),
    1700,
    '待结清合计应是 17.00 元（10 + 7），实际 ' +
      u.reduce(function (s, x) { return s + cents(x.amount); }, 0)
  );
});

test('unsettled：反向欠款更多时方向翻转为反方向净额（甲欠乙 15、乙欠甲 3 → 只报甲欠乙 12）', function () {
  // 甲垫 6 元两人分（乙欠 3），乙垫 30 元两人分（甲欠 15）→ 净额是甲欠乙 12
  const list = [
    makeExpense({ id: 'a1', amount: 6, payer: '甲', participants: people(['甲', '乙']) }),
    makeExpense({ id: 'b1', amount: 30, payer: '乙', participants: people(['甲', '乙']) })
  ];
  const u = F.unsettled(list);
  assert.equal(u.length, 1, '同一对账只应出一条净额，实际 ' + JSON.stringify(u));
  assert.equal(u[0].from, '甲', '净额方向应是 甲 → 乙，实际 ' + u[0].from + ' → ' + u[0].to);
  assert.equal(cents(u[0].amount), 1200, '净额应为 12.00 元');
  assert.equal(cents(u[0].offset), 300, '被抵消的 3.00 元应记进 offset');
});

test('unsettled：两人互垫等额（各 10 元）抵消后完全为空', function () {
  // 防的是「双向欠款抵消只做了一半，账面上永远挂着两笔」
  const list = [
    makeExpense({ id: 'c1', amount: 10, payer: 'A', participants: people(['A', 'B']) }),
    makeExpense({ id: 'c2', amount: 10, payer: 'B', participants: people(['A', 'B']) })
  ];
  assert.deepEqual(F.unsettled(list), [], '等额互相垫付应抵消成空数组，实际 ' + JSON.stringify(F.unsettled(list)));
});

test('unsettled：只有自己承担的开支不产生待结清项', function () {
  const list = [makeExpense({ id: 'solo', amount: 5, payer: 'A', participants: people(['A']) })];
  assert.deepEqual(F.unsettled(list), [], '自己买自己的东西不该显示"待结清"');
});

test('unsettled：部分结清（settled 标记）只留下没结的那份', function () {
  // 防的是「勾了已结清却还在催缴」，或反过来「结清标记把整笔都抹掉」
  const list = [
    makeExpense({
      id: 'part',
      amount: 12,
      payer: 'A',
      participants: people(['A', 'B', 'C']),
      settled: { B: true }
    })
  ];
  const u = F.unsettled(list);
  assert.equal(u.length, 1, '只剩 C 一份未结清，实际 ' + JSON.stringify(u));
  assert.equal(u[0].from, 'C', '未结清的人应是 C');
  assert.equal(cents(u[0].amount), 400, 'C 应结 4.00 元');
});

test('unsettledItems：按笔展开 3 条明细，字段与金额都对得上', function () {
  const items = F.unsettledItems(ledgerFixture());
  assert.deepEqual(
    items.map(function (x) { return [x.debtor, x.creditor, cents(x.share), x.item, x.date]; }),
    [
      ['乙', '甲', 1000, '网费', '2026-09-01'],
      ['丙', '甲', 1000, '网费', '2026-09-01'],
      ['甲', '乙', 300, '电费', '2026-09-01']
    ],
    '逐笔明细不对，实际 ' + JSON.stringify(items)
  );
  assert.deepEqual(
    items.map(function (x) { return x.expenseId; }),
    ['e1', 'e1', 'e2'],
    '每条明细都要带 expenseId，否则页面点不进原记录'
  );
  assert.equal(
    items.reduce(function (s, x) { return s + cents(x.share); }, 0),
    2300,
    '逐笔毛额合计应是 23.00 元（10+10+3），与抵消后的 17.00 元不同是正常的'
  );
});

/* ================================ settlePair ================================ */

test('settlePair：结清甲/乙这一对后，unsettled 里不再出现该对，其他人的欠款不受影响', function () {
  const kept = F.unsettled(F.settlePair(ledgerFixture(), '乙', '甲'));
  assert.equal(kept.length, 1, '应只剩丙→甲 一条，实际 ' + JSON.stringify(kept));
  assert.deepEqual(
    kept.map(function (x) { return [x.from, x.to, cents(x.amount)]; }),
    [['丙', '甲', 1000]],
    '甲/乙之间（含反向的 3 元）应全部消失，丙→甲的 10 元必须留着'
  );
  assert.equal(
    kept.filter(function (x) {
      return (x.from === '乙' && x.to === '甲') || (x.from === '甲' && x.to === '乙');
    }).length,
    0,
    '甲/乙这一对（正反两个方向）都该消失，实际 ' + JSON.stringify(kept)
  );
});

test('settlePair：反向结清（甲、乙换个顺序传参）结果一致', function () {
  const a = F.unsettled(F.settlePair(ledgerFixture(), '乙', '甲'));
  const b = F.unsettled(F.settlePair(ledgerFixture(), '甲', '乙'));
  assert.deepEqual(a, b, '结清同一对时，参数顺序不应影响结果');
});

test('settlePair：返回新对象、不改动入参，且结清标记落在欠债人身上', function () {
  const list = ledgerFixture();
  const snapshot = JSON.stringify(list);
  const out = F.settlePair(list, '乙', '甲');

  assert.equal(JSON.stringify(list), snapshot, 'settlePair 不能就地改入参（页面还拿着旧数组）');
  assert.ok(out[0] !== list[0], '每条记录都应返回新对象');
  assert.deepEqual(out[0].settled, { 乙: true }, 'e1（甲垫）应标记欠债人乙已结清');
  assert.deepEqual(out[1].settled, { 甲: true }, 'e2（乙垫）应标记欠债人甲已结清');
  assertSharesSumTo(out[0].shares, 30, 'settlePair 重算后的 shares 合计仍须等于 30 元');
});

/* ================================ parseExpense ================================ */

test('parseExpense：「今天买水 12.4 四个人分」→ 12.40 元 / 饮用水 / 4 人平摊', function () {
  const r = F.parseExpense('今天买水 12.4 四个人分', members4(), '陈默');
  assert.equal(r.ok, true, '应识别成功，warnings=' + JSON.stringify(r.warnings));
  assert.equal(cents(r.amount), 1240, '金额应为 12.40 元，实际 ' + r.amount);
  assert.equal(r.category, '饮用水', '买水应归到饮用水，实际 ' + r.category);
  assert.equal(r.item, '饮用水', '项目名应是饮用水，实际 ' + r.item);
  assert.equal(r.payer, '陈默', '没提垫付人时应记在当前记账人头上');
  assert.deepEqual(r.parts, members4(), '四个人分＝全寝 4 人，实际 ' + JSON.stringify(r.parts));
  assert.equal(r.mode, 'equal', '默认是等额分摊');
  assert.deepEqual(r.warnings, [], '这条不该有任何警告，实际 ' + JSON.stringify(r.warnings));
});

test('parseExpense：「我垫了网费 120，全寝室 AA」→ 120 元 / 网费 / 4 人', function () {
  const r = F.parseExpense('我垫了网费 120，全寝室 AA', members4(), '陈默');
  assert.equal(cents(r.amount), 12000, '金额应为 120.00 元，实际 ' + r.amount);
  assert.equal(r.item, '网费', '项目名应是网费，实际 ' + r.item);
  assert.equal(r.category, '网费', '类别应是网费，实际 ' + r.category);
  assert.equal(r.payer, '陈默', '"我垫了"应记在当前记账人头上');
  assert.deepEqual(r.parts, members4(), '全寝室 AA＝4 人，实际 ' + JSON.stringify(r.parts));
});

test('parseExpense：「电费 86 块 4，平摊」→ 86.40 元（块+角 的写法不能只取到 86）', function () {
  // 防的是「86 块 4」被解析成 86 元，一个月下来少记几块钱没人发现
  const r = F.parseExpense('电费 86 块 4，平摊', members4(), '陈默');
  assert.equal(cents(r.amount), 8640, '"86 块 4"应解析成 86.40 元，实际 ' + r.amount);
  assert.equal(r.item, '电费', '项目名应是电费，实际 ' + r.item);
  assert.equal(r.category, '电费', '类别应是电费，实际 ' + r.category);
  assert.deepEqual(r.parts, members4(), '"平摊"默认全体 4 人');
});

test('parseExpense：「空调电费我和王雨分，一共 60」→ 60 元，只把我和王雨算参与人', function () {
  const r = F.parseExpense('空调电费我和王雨分，一共 60', members4(), '陈默');
  assert.equal(cents(r.amount), 6000, '金额应为 60.00 元，实际 ' + r.amount);
  assert.deepEqual(r.parts, ['陈默', '王雨'], '参与人应只有我和王雨，实际 ' + JSON.stringify(r.parts));
  assert.equal(r.payer, '陈默', '句子只是"我和王雨分"，没有垫付动词，不能把王雨当垫付人');
  assert.equal(r.category, '电费', '空调电费应归电费，实际 ' + r.category);
});

test('parseExpense：「李昊垫了卫生纸 20 块，三个人分」→ 垫付人识别为李昊，并提示人数不符', function () {
  const r = F.parseExpense('李昊垫了卫生纸 20 块，三个人分', members4(), '陈默');
  assert.equal(cents(r.amount), 2000, '金额应为 20.00 元，实际 ' + r.amount);
  assert.equal(r.payer, '李昊', '句子里出现成员名且带垫付动词时，垫付人应识别为该成员');
  assert.equal(r.item, '卫生纸', '项目名应是卫生纸，实际 ' + r.item);
  assert.equal(r.category, '日用品', '卫生纸应归日用品，实际 ' + r.category);
  assert.ok(
    r.warnings.some(function (w) { return w.indexOf('垫付人识别为 李昊') >= 0; }),
    '识别到别人的垫付要提示核对，实际 warnings=' + JSON.stringify(r.warnings)
  );
  assert.ok(
    r.warnings.some(function (w) { return w.indexOf('3 人') >= 0 && w.indexOf('4 人') >= 0; }),
    '说 3 人而寝室 4 人时要提示分摊人数不一致，实际 warnings=' + JSON.stringify(r.warnings)
  );
});

test('parseExpense：「公共零食 45，除了我之外的3个人分」→ 45 元 / 食品 / 排除我', function () {
  const r = F.parseExpense('公共零食 45，除了我之外的3个人分', members4(), '陈默');
  assert.equal(cents(r.amount), 4500, '金额应为 45.00 元，实际 ' + r.amount);
  assert.equal(r.category, '食品', '零食应归食品，实际 ' + r.category);
  assert.deepEqual(r.parts, ['李昊', '王雨', '赵小满'], '"除了我"应把陈默排除，实际 ' + JSON.stringify(r.parts));
  assert.ok(
    r.warnings.some(function (w) { return w.indexOf('除我之外') >= 0; }),
    '排除自己这种特殊理解必须给出警告，实际 warnings=' + JSON.stringify(r.warnings)
  );
});

test('parseExpense：空输入 → ok=false、金额 0、提示"还没输入内容"', function () {
  const r = F.parseExpense('   ', members4(), '陈默');
  assert.equal(r.ok, false, '空输入不能算识别成功');
  assert.equal(r.amount, 0, '空输入金额应为 0');
  assert.deepEqual(r.warnings, ['还没输入内容'], '空输入应只有一句提示，实际 ' + JSON.stringify(r.warnings));
});

test('parseExpense：只说了「买水」没说金额 → ok=false 并提示补金额', function () {
  const r = F.parseExpense('买水', members4(), '陈默');
  assert.equal(r.ok, false, '没金额不能入账');
  assert.equal(r.amount, 0, '没金额时 amount 应为 0');
  assert.ok(
    r.warnings.some(function (w) { return w.indexOf('没听出金额') >= 0; }),
    '应提示补一句多少钱，实际 warnings=' + JSON.stringify(r.warnings)
  );
  assert.equal(r.category, '饮用水', '即使没金额，类别也应猜对，方便用户直接补数字');
});

test('parseExpense：「电费 90 元 按天分摊」→ mode=days 并提示填天数', function () {
  const r = F.parseExpense('电费 90 元 按天分摊', members4(), '陈默');
  assert.equal(r.mode, 'days', '"按天"应切到按天数分摊模式，实际 ' + r.mode);
  assert.equal(cents(r.amount), 9000, '金额应为 90.00 元，实际 ' + r.amount);
  assert.ok(
    r.warnings.some(function (w) { return w.indexOf('按居住天数') >= 0; }),
    '按天分摊要提醒补每人天数，实际 warnings=' + JSON.stringify(r.warnings)
  );
});

test('parseExpense：置信度随命中信号增加（4 个信号 ≈ 0.88，只有金额 ≈ 0.77）', function () {
  // 防的是置信度恒为 0.5 或越界 >1；页面用它显示"置信度 xx%"
  const rich = F.parseExpense('今天买水 12.4 四个人分', members4(), '陈默');
  assert.ok(Math.abs(rich.confidence - 0.88) < 1e-9, '三个信号 + 0.55 底数 = 0.88，实际 ' + rich.confidence);
  const thin = F.parseExpense('桶装水 20 元', members4(), '陈默');
  assert.ok(Math.abs(thin.confidence - 0.77) < 1e-9, '两个信号 = 0.77，实际 ' + thin.confidence);
  [rich, thin].forEach(function (r) {
    assert.ok(r.confidence > 0.5 && r.confidence <= 0.98, '置信度应落在 (0.5, 0.98]，实际 ' + r.confidence);
  });
});

test('parseExpense：只读 members，不会把调用方传进来的成员数组改掉', function () {
  const M = members4();
  F.parseExpense('今天买水 12.4 四个人分', M, '陈默');
  assert.deepEqual(M, members4(), 'members 被改过：' + JSON.stringify(M));
});

/* ================================ parseReceiptText ================================ */

test('parseReceiptText：一行一件商品的真实票面，4 行明细、合计 49.80、日期商家都对', function () {
  // 票面故意写成常见 OCR 输出：商家 + 日期时间 + 4 行商品 + 合计行
  const text = [
    '校园超市（东区店）',
    '2026-10-20 19:32',
    '抽纸 6.50',
    '矿泉水 13.80',
    '洗衣液 24.00',
    '垃圾袋 5.50',
    '合计 49.80'
  ].join('\n');
  const r = F.parseReceiptText(text);

  assert.equal(r.lines.length, 4, '应解析出 4 行明细，实际 ' + r.lines.length + ' 行：' + JSON.stringify(r.lines));
  assert.deepEqual(
    r.lines.map(function (l) { return [l.name, cents(l.amount)]; }),
    [['抽纸', 650], ['矿泉水', 1380], ['洗衣液', 2400], ['垃圾袋', 550]],
    '明细名称/金额不对，实际 ' + JSON.stringify(r.lines)
  );
  assert.equal(cents(r.sum), 4980, '明细加总应为 49.80 元，实际 ' + r.sum);
  assert.equal(cents(r.total), 4980, '票面合计应为 49.80 元，实际 ' + r.total);
  assert.equal(r.merchant, '校园超市（东区店）', '商家应为票面首行，实际 ' + r.merchant);
  assert.equal(r.date, '2026-10-20', '日期应归一成 YYYY-MM-DD，实际 ' + r.date);
  assert.deepEqual(r.warnings, [], '票面自洽时不该有警告，实际 ' + JSON.stringify(r.warnings));
  assert.ok(r.confidence > 0.8, '4 行都识别到时置信度应偏高，实际 ' + r.confidence);
});

test('parseReceiptText：忽略 x2 数量后缀与"存到相册"这类截图按钮文字', function () {
  const text = [
    '便利店小票',
    '2026-10-21',
    '存到相册',
    '纸巾 x2 13.00',
    '可乐 3.50',
    '合计 16.50',
    '找零 0.00'
  ].join('\n');
  const r = F.parseReceiptText(text);
  assert.deepEqual(
    r.lines.map(function (l) { return [l.name, cents(l.amount)]; }),
    [['纸巾', 1300], ['可乐', 350]],
    '数量后缀应剥掉、按钮文字应丢弃，实际 ' + JSON.stringify(r.lines)
  );
  assert.equal(cents(r.total), 1650, '合计应为 16.50 元（不能被"找零 0.00"覆盖），实际 ' + r.total);
  assert.equal(r.merchant, '便利店小票', '商家应是首行，实际 ' + r.merchant);
});

test('parseReceiptText：明细加总与票面合计不符时给出"相差"警告', function () {
  const text = ['小卖部', '2026-10-22', '水 3.00', '合计 5.00'].join('\n');
  const r = F.parseReceiptText(text);
  assert.equal(cents(r.sum), 300, '明细加总应为 3.00 元，实际 ' + r.sum);
  assert.equal(cents(r.total), 500, '票面合计 5.00 元应被采信，实际 ' + r.total);
  assert.equal(r.warnings.length, 1, '应收敛成一条警告，实际 ' + JSON.stringify(r.warnings));
  assert.ok(r.warnings[0].indexOf('相差 ¥2.00') >= 0, '警告要点出差额 2.00 元，实际：' + r.warnings[0]);
});

test('parseReceiptText：缺日期、缺合计行时按今天/明细加总兜底并各给一条警告', function () {
  const text = ['小卖部', '水 3.00', '饼干 4.50'].join('\n');
  const r = F.parseReceiptText(text);
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, '缺日期时应兜底成今天，实际 ' + r.date);
  assert.equal(cents(r.sum), 750, '明细加总应为 7.50 元，实际 ' + r.sum);
  assert.equal(cents(r.total), 750, '没有合计行时 total 应回落到明细加总，实际 ' + r.total);
  assert.equal(r.warnings.length, 2, '应给出"没日期"+"没合计行"两条警告，实际 ' + JSON.stringify(r.warnings));
  assert.ok(r.warnings[0].indexOf('没识别到日期') >= 0, '第一条应是日期警告，实际：' + r.warnings[0]);
  assert.ok(r.warnings[1].indexOf('合计/实收') >= 0, '第二条应是合计行警告，实际：' + r.warnings[1]);
});

test('parseReceiptText：空文本 → 0 行 0 元，提示"没有可识别的文字"', function () {
  const r = F.parseReceiptText('   \n  \n');
  assert.deepEqual(r.lines, [], '空文本不该有明细行');
  assert.equal(r.total, 0, '空文本总额应为 0');
  assert.equal(cents(r.sum), 0, '空文本加总应为 0');
  assert.deepEqual(r.warnings, ['没有可识别的文字，请粘贴票面内容'], '实际 ' + JSON.stringify(r.warnings));
});

/* ================================ extractJsonFromText / normalizeAiReceipt ================================ */

test('extractJsonFromText：从 ```json 围栏 + 前后废话里抽出对象，字符串里的 } 不截断', function () {
  const text = [
    '好的，识别结果如下：',
    '```json',
    '{"merchant":"校园超市","total":18.5,"note":"金额 } 不是结束","lines":[{"name":"抽纸","amount":13}]}',
    '```',
    '以上仅供参考。'
  ].join('\n');
  const obj = F.extractJsonFromText(text);
  assert.ok(obj, '应能从围栏文本里抽出 JSON，实际拿到 ' + String(obj));
  assert.equal(obj.merchant, '校园超市', '字段值应原样，实际 ' + obj.merchant);
  assert.equal(obj.note, '金额 } 不是结束', '字符串内的 } 不能被当结尾');
  assert.equal(obj.lines.length, 1, 'lines 应完整解析');
});

test('extractJsonFromText：嵌套对象能整段取回；没有 JSON / JSON 语法错时返回 null', function () {
  assert.deepEqual(
    F.extractJsonFromText('前缀 {"a":{"b":1},"c":[1,2]} 后缀'),
    { a: { b: 1 }, c: [1, 2] },
    '嵌套对象应整段解析'
  );
  assert.equal(F.extractJsonFromText('一段没有大括号的话'), null, '没有 JSON 时应返回 null');
  assert.equal(F.extractJsonFromText('{"a":1,}'), null, '语法错的 JSON 应返回 null 而不是抛异常');
});

test('normalizeAiReceipt：字段归一化（商家去空格、日期补零、0 元行丢弃、缺失名称兜底）', function () {
  const obj = F.extractJsonFromText(
    '```json\n{"merchant":" 校园超市 ","date":"2026/10/20","total":18.5,' +
      '"lines":[{"name":"抽纸","qty":2,"amount":13.0},{"name":"","amount":5.5},{"name":"赠品","amount":0}]}\n```'
  );
  const r = F.normalizeAiReceipt(obj, 'DeepSeek', '{}');

  assert.equal(r.merchant, '校园超市', '商家名应 trim，实际 "' + r.merchant + '"');
  assert.equal(r.date, '2026-10-20', '2026/10/20 应归一成 2026-10-20，实际 ' + r.date);
  assert.equal(r.lines.length, 2, '0 元行应被丢弃，实际 ' + JSON.stringify(r.lines));
  assert.deepEqual(
    r.lines.map(function (l) { return [l.name, l.qty, cents(l.amount)]; }),
    [['抽纸', 2, 1300], ['未识别项目', 1, 550]],
    '名称为空要兜底成"未识别项目"、qty 缺省为 1，实际 ' + JSON.stringify(r.lines)
  );
  assert.equal(cents(r.sum), 1850, '明细加总应为 18.50 元，实际 ' + r.sum);
  assert.equal(cents(r.total), 1850, '票面总额应为 18.50 元，实际 ' + r.total);
  assert.deepEqual(r.warnings, [], '明细与总额自洽时不该有警告，实际 ' + JSON.stringify(r.warnings));
  assert.equal(r.provider, 'DeepSeek', '来源要写进结果，页面标题会显示，实际 ' + r.provider);
});

test('normalizeAiReceipt：JSON 没解析出来时给出明确提示，而不是把 0 元当真', function () {
  const r = F.normalizeAiReceipt(null, 'DeepSeek', '模型说了点别的');
  assert.equal(cents(r.total), 0, '解析失败时总额应为 0');
  assert.deepEqual(r.lines, [], '解析失败时不该凭空造明细');
  assert.ok(
    r.warnings[0].indexOf('模型没返回可解析的 JSON') >= 0,
    '第一条警告应提示重试/改粘贴文字，实际 ' + JSON.stringify(r.warnings)
  );
  assert.equal(r.provider, 'DeepSeek', '失败也要记住来源，方便日志排查');
});

test('normalizeAiReceipt：模型给的总额与明细不符时保留总额并提示差额', function () {
  const r = F.normalizeAiReceipt(
    { merchant: '小卖部', date: '2026-10-23', total: 20, lines: [{ name: '水', amount: 18.5 }] },
    '通义千问',
    ''
  );
  assert.equal(cents(r.total), 2000, '票面总额应被采信（模型总数通常比逐行准），实际 ' + r.total);
  assert.equal(cents(r.sum), 1850, '明细加总应为 18.50 元，实际 ' + r.sum);
  assert.ok(
    r.warnings.some(function (w) { return w.indexOf('相差 ¥1.50') >= 0; }),
    '应提示差额 1.50 元，实际 ' + JSON.stringify(r.warnings)
  );
});

test('normalizeAiReceipt：日期写成 2026-1-2 也补零，缺日期则回落到今天并给警告', function () {
  const spaced = F.normalizeAiReceipt({ merchant: 'x', date: '2026-1-2', total: 1, lines: [] }, 'p', '');
  assert.equal(spaced.date, '2026-01-02', '2026-1-2 应补零成 2026-01-02，实际 ' + spaced.date);

  const noDate = F.normalizeAiReceipt({ merchant: 'x', total: 1, lines: [] }, 'p', '');
  assert.match(noDate.date, /^\d{4}-\d{2}-\d{2}$/, '缺日期时应兜底成今天，实际 ' + noDate.date);
  assert.ok(
    noDate.warnings.some(function (w) { return w.indexOf('没识别到日期') >= 0; }),
    '缺日期必须提示，实际 ' + JSON.stringify(noDate.warnings)
  );
});

/* ================================ makeReport ================================ */

test('makeReport：两笔账的总额/人均/笔数/类别占比/结清比例都算对', function () {
  const M = members4();
  const list = [
    makeExpense({ id: 'a', date: '2026-09-01', item: '网费', category: '网费', amount: 120, payer: '陈默', participants: people(M) }),
    makeExpense({ id: 'b', date: '2026-09-02', item: '电费', category: '电费', amount: 86.4, payer: '李昊', participants: people(['陈默', '李昊']) })
  ];
  const r = F.makeReport(list, M);

  assert.equal(cents(r.total), 20640, '总额应为 206.40 元，实际 ' + r.total);
  assert.equal(cents(r.per), 5160, '4 人人均应为 51.60 元，实际 ' + r.per);
  assert.equal(r.count, 2, '笔数应为 2，实际 ' + r.count);
  assert.equal(
    r.cats.reduce(function (s, c) { return s + cents(c.amount); }, 0),
    cents(r.total),
    '各分类金额之和必须等于总额'
  );
  assert.deepEqual(
    r.cats.map(function (c) { return [c.cat, cents(c.amount), c.pct]; }),
    [['网费', 12000, 58], ['电费', 8640, 42]],
    '分类占比应是 58% / 42%，实际 ' + JSON.stringify(r.cats)
  );
  assert.equal(
    r.cats.reduce(function (s, c) { return s + c.pct; }, 0),
    100,
    '两位类别时占比之和应正好 100，实际 ' + r.cats.map(function (c) { return c.pct; }).join('+')
  );
  assert.equal(cents(r.openTotal), 7320, '待结清应为 73.20 元，实际 ' + r.openTotal);
  assert.equal(r.closedRatio, 65, '结清比例应为 65%，实际 ' + r.closedRatio);
  assert.ok(r.text.indexOf('¥206.40') >= 0, '月报正文应写明总额，实际：' + r.text.split('\n')[0]);
  assert.ok(r.text.indexOf('65%') >= 0, '月报正文应写明结清比例，实际：' + r.text);
});

test('makeReport：全部结清时结清比例 100%、待结清 0，正文给出健康提示', function () {
  const M = members4();
  const settledAll = { 陈默: true, 李昊: true, 王雨: true, 赵小满: true };
  const list = [
    makeExpense({ id: 'a', date: '2026-09-01', item: '网费', category: '网费', amount: 120, payer: '陈默', participants: people(M), settled: settledAll })
  ];
  const r = F.makeReport(list, M);
  assert.equal(cents(r.openTotal), 0, '全部结清时待结清应为 0，实际 ' + r.openTotal);
  assert.equal(r.closedRatio, 100, '结清比例应为 100%，实际 ' + r.closedRatio);
  assert.ok(r.text.indexOf('全部结清') >= 0, '正文应给出全部结清提示，实际：' + r.text);
});

test('makeReport：空账本 → 全 0、结清比例 100，不抛异常', function () {
  const r = F.makeReport([], members4());
  assert.equal(cents(r.total), 0, '空账本总额应为 0');
  assert.equal(cents(r.per), 0, '空账本人均应 0（不能出现 NaN）');
  assert.equal(r.count, 0, '空账本笔数应为 0');
  assert.deepEqual(r.cats, [], '空账本不该有分类');
  assert.deepEqual(r.open, [], '空账本不该有待结清');
  assert.equal(cents(r.openTotal), 0, '空账本待结清应为 0');
  assert.equal(r.closedRatio, 100, '空账本视为 100% 结清，实际 ' + r.closedRatio);
  assert.ok(r.text.indexOf('全部结清') >= 0, '空账本正文也要有结论，实际：' + r.text);
});

test('makeReport：只统计当月——当月一笔 + 去年一笔，总额只算当月那笔', function () {
  // 防的是「月报把历史账滚动进来，越用越大」；日期取模块自己的 monthKey，避免用例跟着系统时间变红
  const M = members4();
  const now = F.monthKey() + '-15';
  const list = [
    makeExpense({ id: 'now', date: now, item: '本月网费', category: '网费', amount: 999, payer: '陈默', participants: people(M) }),
    makeExpense({ id: 'old', date: '2020-01-15', item: '去年电费', category: '电费', amount: 1, payer: '陈默', participants: people(M) })
  ];
  const r = F.makeReport(list, M);
  assert.equal(r.count, 1, '当月只有 1 笔，实际 ' + r.count);
  assert.equal(cents(r.total), 99900, '总额应只算当月的 999.00 元，实际 ' + r.total);
  assert.deepEqual(
    r.cats.map(function (c) { return c.cat; }),
    ['网费'],
    '去年那笔的分类不该出现，实际 ' + JSON.stringify(r.cats)
  );
});

test('makeReport：三个类别各占三分之一时，占比合计允许四舍五入误差但总和约 100', function () {
  const M = members4();
  const list = ['食品', '电费', '网费'].map(function (cat, i) {
    return makeExpense({ id: 'c' + i, date: '2026-09-0' + (i + 1), category: cat, amount: 10, payer: '陈默', participants: people(M) });
  });
  const r = F.makeReport(list, M);
  const pctSum = r.cats.reduce(function (s, c) { return s + c.pct; }, 0);
  assert.ok(
    Math.abs(pctSum - 100) <= 2,
    '三个 33% 相加是 99% 属正常，但偏差超过 2 个百分点说明算法坏了，实际 ' + pctSum + '%'
  );
  r.cats.forEach(function (c) {
    const want = Math.round((c.amount / r.total) * 100);
    assert.equal(c.pct, want, c.cat + ' 占比应为 ' + want + '%，实际 ' + c.pct);
  });
});

test('makeReport：结清比例是 0–100 的整数（不能出现 >100% 或小数）', function () {
  const M = members4();
  const cases = [
    [makeExpense({ id: 'a', amount: 100, payer: '陈默', participants: people(M) })],
    [makeExpense({ id: 'b', amount: 100, payer: '陈默', participants: people(['陈默']) })],
    [
      makeExpense({ id: 'c', amount: 100, payer: '陈默', participants: people(M) }),
      makeExpense({ id: 'd', amount: 50, payer: '李昊', participants: people(['陈默', '李昊']), settled: { 陈默: true } })
    ]
  ];
  cases.forEach(function (list, i) {
    const r = F.makeReport(list, M);
    assert.ok(Number.isInteger(r.closedRatio), '第 ' + (i + 1) + ' 组结清比例应是整数，实际 ' + r.closedRatio);
    assert.ok(r.closedRatio >= 0 && r.closedRatio <= 100, '第 ' + (i + 1) + ' 组结清比例越界：' + r.closedRatio);
  });
});

/* ================================ makeReminder ================================ */

test('makeReminder：三种语气都写明金额与昵称，有对冲金额时也要出现在话术里', function () {
  const items = [{ item: '网费' }, { item: '电费' }];
  const fun = F.makeReminder('乙', '王雨', 7, items, 'fun', 3);
  assert.ok(fun.indexOf('¥7.00') >= 0, '搞笑版要写金额 ¥7.00，实际：' + fun);
  assert.ok(fun.indexOf('小雨') >= 0, '债权人应使用昵称小雨，实际：' + fun);
  assert.ok(fun.indexOf('¥3.00') >= 0, '已对冲的 3.00 元也要讲清楚，实际：' + fun);
  assert.ok(fun.indexOf('网费、电费') >= 0, '两笔明细都应带上，实际：' + fun);

  const direct = F.makeReminder('乙', '王雨', 7, items, 'direct', 3);
  assert.ok(direct.indexOf('¥7.00') >= 0, '直接版要写金额，实际：' + direct);
  assert.ok(direct.indexOf('网费、电费') >= 0, '直接版要列明细，实际：' + direct);

  const soft = F.makeReminder('乙', '王雨', 7, items, 'soft', 0);
  assert.ok(soft.indexOf('¥7.00') >= 0, '委婉版要写金额，实际：' + soft);
  assert.ok(soft.indexOf('¥3.00') < 0, '没有对冲金额时不能凭空出现扣款说明，实际：' + soft);
});

/* ================================ renameMember ================================ */

test('renameMember：改名同步成员/记账人/历史记录的垫付人与参与人，并清空 shares 待重算', function () {
  const state = {
    members: ['甲', '乙'],
    me: '甲',
    expenses: [
      makeExpense({ id: 'r1', amount: 10, payer: '甲', participants: people(['甲', '乙']) }),
      makeExpense({ id: 'r2', amount: 6, payer: '乙', participants: people(['甲', '乙']), settled: { 甲: true } })
    ]
  };
  const snapshot = JSON.stringify(state);
  const out = F.renameMember(state, '甲', '阿甲');

  assert.deepEqual(out.members, ['阿甲', '乙'], '成员列表要改名，实际 ' + JSON.stringify(out.members));
  assert.equal(out.me, '阿甲', '当前记账人要跟着改');
  assert.equal(out.expenses[0].payer, '阿甲', '垫付人要改名');
  assert.deepEqual(
    out.expenses[0].participants.map(function (p) { return p.name; }),
    ['阿甲', '乙'],
    '参与人要改名，实际 ' + JSON.stringify(out.expenses[0].participants)
  );
  assert.deepEqual(out.expenses[1].settled, { 阿甲: true }, '结清标记的键也要跟着改名，否则已结清会"复活"');
  assert.equal(out.expenses[0].shares, null, 'shares 应置空让下游按新成员重算');
  assert.equal(JSON.stringify(state), snapshot, '改名不能改动原 state');
});

/* ================================ seed / 小工具 ================================ */

test('seed：生成 6 条演示数据，每条 shares 合计都等于金额，日期落在当月', function () {
  const sd = F.seed(['A', 'B', 'C']);
  assert.equal(sd.length, 6, '演示数据应是 6 条，实际 ' + sd.length);
  assert.equal(new Set(sd.map(function (e) { return e.id; })).size, 6, 'id 必须唯一');
  assert.equal(
    sd.reduce(function (s, e) { return s + cents(e.amount); }, 0),
    35520,
    '演示数据总额应为 355.20 元，实际 ' + sd.reduce(function (s, e) { return s + e.amount; }, 0)
  );
  sd.forEach(function (e) {
    assertSharesSumTo(e.shares, e.amount, 'seed ' + e.id);
    assert.equal(e.participants.length, 3, 'seed(' + e.id + ') 的参与人应等于成员数');
    assert.ok(e.date.indexOf(F.monthKey()) === 0, '演示数据应落在当月，实际 ' + e.date);
  });
});

test('num / fmt / plain：金额统一两位小数，非数字一律归 0', function () {
  // 防的是「9.155 显示成 9.15」「NaN 一路传到页面显示 NaN 元」
  assert.equal(cents(F.num(9.155)), 916, '9.155 应四舍五入成 9.16，实际 ' + F.num(9.155));
  assert.equal(cents(F.num('12.345')), 1235, '字符串金额也应能收敛，实际 ' + F.num('12.345'));
  assert.equal(F.num(NaN), 0, 'NaN 应归 0');
  assert.equal(F.num('不是数字'), 0, '非数字字符串应归 0');
  assert.equal(F.fmt(3.5), '¥3.50', 'fmt 应带币种和两位小数，实际 ' + F.fmt(3.5));
  assert.equal(F.plain(3.5), '3.50', 'plain 应是纯数字两位小数，实际 ' + F.plain(3.5));
});

test('guessCategory：常见说法都能归到正确类别，认不出来落"其他"', function () {
  assert.equal(F.guessCategory('今天买水 12.4'), '饮用水', '买水应归饮用水');
  assert.equal(F.guessCategory('宽带续费 100'), '网费', '宽带应归网费');
  assert.equal(F.guessCategory('电费 86 块 4'), '电费', '电费应归电费');
  assert.equal(F.guessCategory('买卫生纸 20 块'), '日用品', '卫生纸应归日用品');
  assert.equal(F.guessCategory('公共零食 45'), '食品', '零食应归食品');
  assert.equal(F.guessCategory('微波炉维修 60'), '维修', '维修应归维修');
  assert.equal(F.guessCategory('不知道算什么'), '其他', '认不出来应落"其他"');
});
