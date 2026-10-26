'use strict';
/* 单元测试 + 合成数据回归测试（node --test，零依赖）
   运行：node --test tests/ */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

/* ---- 固定用例：基础能量公式 ---- */
test('BMR 男 170cm/65kg/25岁 = 1593（Mifflin-St Jeor）', () => {
  assert.strictEqual(C.calcBmr({ sex: 'male', height: 170, weight: 65, age: 25 }), 1593);
});
test('BMR 女 170cm/65kg/25岁 = 1427', () => {
  assert.strictEqual(C.calcBmr({ sex: 'female', height: 170, weight: 65, age: 25 }), 1427);
});
test('BMR 资料不全返回 0', () => {
  assert.strictEqual(C.calcBmr({ sex: 'male', height: 0, weight: 65, age: 25 }), 0);
  assert.strictEqual(C.calcBmr(null), 0);
});
test('TDEE = BMR × 1.375 = 2190', () => {
  assert.strictEqual(C.calcTdee({ sex: 'male', height: 170, weight: 65, age: 25, activity: 1.375 }), 2190);
});
test('预算 = TDEE − 缺口 = 1890', () => {
  assert.strictEqual(C.calcBudget({ sex: 'male', height: 170, weight: 65, age: 25, activity: 1.375, deficit: 300 }), 1890);
  assert.strictEqual(C.calcBudget({ sex: 'male', height: 170, weight: 65, age: 25, activity: 1.375, deficit: -50 }), 2190, '负缺口按 0 处理');
});
test('运动消耗 = MET × 体重 × 时长', () => {
  assert.strictEqual(C.exKcal(3, 65, 30), 98);      // 散步 30 分钟
  assert.strictEqual(C.exKcal(8, 65, 60), 520);     // 慢跑 1 小时
  assert.strictEqual(C.exKcal(3, 0, 30), 0);
});
test('步数消耗 = 步数 × 0.0005 × 体重', () => {
  assert.strictEqual(C.stepsKcal(10000, 65), 325);
});
test('只填热量时按供能比例估算宏量营养（15/30/55）', () => {
  const m = C.estimateMacros(400);
  assert.deepStrictEqual(m, { p: 15, f: 13.3, c: 55, est: true });
});
test('减脂期营养建议值（65kg、预算1890）', () => {
  assert.deepStrictEqual(C.nutritionTargets(65, 1890), { p: 98, f: 53, c: 255, fb: 25, na: 2000 });
  assert.strictEqual(C.nutritionTargets(0, 1890), null);
});

/* ---- 趋势体重 EMA ---- */
test('EMA 趋势体重：alpha=0.1 逐步逼近秤值', () => {
  const t = C.emaTrend([
    { date: '2026-01-03', kg: 71 },
    { date: '2026-01-01', kg: 70 },
    { date: '2026-01-02', kg: 69 }
  ]);
  assert.deepStrictEqual(t.map(p => p.date), ['2026-01-01', '2026-01-02', '2026-01-03'], '乱序输入要按日期排序');
  assert.strictEqual(t[0].trend, 70);
  assert.strictEqual(t[1].trend, 69.9);
  assert.ok(Math.abs(t[2].trend - 70.01) < 1e-9);
});

/* ---- 体重回归斜率 ---- */
test('weightSlope：两点成线斜率精确', () => {
  const r = C.weightSlope(
    [{ date: '2026-01-01', kg: 70 }, { date: '2026-01-11', kg: 69.1 }],
    '2026-01-01', '2026-01-11'
  );
  assert.strictEqual(r.n, 2);
  assert.ok(Math.abs(r.slope - (-0.09)) < 1e-9); // -0.9kg / 10天
});
test('weightSlope：区间过滤与数据不足', () => {
  const ws = [{ date: '2026-01-01', kg: 70 }, { date: '2026-02-01', kg: 69 }];
  assert.strictEqual(C.weightSlope(ws, '2026-01-01', '2026-01-15'), null, '区间内只有 1 点 → null');
  assert.strictEqual(C.weightSlope([], '2026-01-01', '2026-01-15'), null);
});

/* ---- 账实核对 ---- */
test('ledgerCheck：实际比预测少减 0.4kg/14天 ≈ 每天 220 千卡', () => {
  const r = C.ledgerCheck({ days: 14, predKg: -1.2, actualKg: -0.8 });
  assert.strictEqual(r.gapKg, 0.4);
  assert.strictEqual(r.gapKcal, 220);
  assert.strictEqual(r.cls, 'good');
});
test('ledgerCheck：偏差分级', () => {
  assert.strictEqual(C.ledgerCheck({ days: 14, predKg: -1.0, actualKg: -0.4 }).cls, 'warn'); // 差0.6kg
  assert.strictEqual(C.ledgerCheck({ days: 14, predKg: -2.0, actualKg: -0.6 }).cls, 'bad');  // 差1.4kg
  assert.strictEqual(C.ledgerCheck({ days: 3, predKg: -0.3, actualKg: 0 }), null, '不足7天');
});

/* ---- 周度分块 ---- */
test('weeklyBlocks：30天切成 7/7/7/9，短尾并入前块', () => {
  const days = Array.from({ length: 30 }, (_, i) => 'd' + i);
  assert.deepStrictEqual(C.weeklyBlocks(days).map(b => b.length), [7, 7, 7, 9]);
});
test('weeklyBlocks：空与短区间', () => {
  assert.deepStrictEqual(C.weeklyBlocks([]), []);
  assert.deepStrictEqual(C.weeklyBlocks(['a', 'b', 'c']).map(b => b.length), [3]);
});

/* ---- 图表刻度 ---- */
test('niceCeil/niceTicks 基本性质', () => {
  assert.strictEqual(C.niceCeil(1890), 2000);
  assert.strictEqual(C.niceFloor(1890), 0); // 步长取 2000，向下取整到 0
  const ticks = C.niceTicks(0, 2200);
  assert.ok(ticks.every((v, i) => i === 0 || v > ticks[i - 1]), '刻度递增');
  assert.strictEqual(ticks[0], 0);
});

/* ============================================================
   合成数据回归测试（验收标准：注入已知 TDEE，反推误差 ≤±50 千卡）
   模拟 90 天：真实 TDEE=2400、真实摄入=2000（每天缺口 400），
   体秤噪声 σ=0.5kg、摄入记录误差 σ=100 千卡，固定随机种子。
   ============================================================ */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss(rnd) { // Box-Muller
  return Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
}
function synth90() {
  const rnd = mulberry32(20261026);
  const start = Date.UTC(2026, 6, 1); // 2026-07-01，共 90 天至 2026-09-28
  const ds = i => {
    const d = new Date(start + i * 86400000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  };
  const TRUE_TDEE = 2400, TRUE_INTAKE = 2000, K = C.KCAL_PER_KG;
  let body = 70;
  const weights = [], intakes = [];
  for (let i = 0; i < 90; i++) {
    body += (TRUE_INTAKE - TRUE_TDEE) / K;      // 身体能量按真实值演化
    weights.push({ date: ds(i), kg: +(body + 0.5 * gauss(rnd)).toFixed(2) });
    intakes.push({ date: ds(i), kcal: Math.max(0, Math.round(TRUE_INTAKE + 100 * gauss(rnd))) });
  }
  return { weights: weights, intakes: intakes, start: '2026-07-01', end: '2026-09-28' };
}

test('合成数据回归：90天反推真实TDEE 误差≤±50千卡', () => {
  const s = synth90();
  const avgIntake = s.intakes.reduce((a, r) => a + r.kcal, 0) / s.intakes.length;
  const fit = C.weightSlope(s.weights, s.start, s.end);
  assert.ok(fit && fit.n >= 85, '称重覆盖应接近 90 天，实际 ' + (fit && fit.n));
  const est = C.estimateRealTdee({ avgIntake: avgIntake, slopeKgPerDay: fit.slope, avgBurnRec: 0 });
  assert.ok(Math.abs(est.realTotal - 2400) <= 50,
    '反推 realTotal=' + est.realTotal + '，期望 2400±50');
  assert.ok(Math.abs(est.realBase - 2400) <= 50, 'realBase=' + est.realBase);
});

test('合成数据回归：账实核对 gap ≤ ±60 千卡/天（记录误差为零均值时）', () => {
  const s = synth90();
  const days = 90;
  const avgIntake = s.intakes.reduce((a, r) => a + r.kcal, 0) / s.intakes.length;
  const fit = C.weightSlope(s.weights, s.start, s.end);
  const predKg = -((2400 - avgIntake) * days) / C.KCAL_PER_KG; // 按"公式 TDEE=2400"的记录预测体重变化
  const actualKg = fit.slope * days;
  const r = C.ledgerCheck({ days: days, predKg: predKg, actualKg: actualKg });
  assert.ok(r, '账实核对应可计算');
  assert.ok(Math.abs(r.gapKcal) <= 60, 'gapKcal=' + r.gapKcal + '，期望 ≤60（真实缺口记录无误时接近 0）');
});
