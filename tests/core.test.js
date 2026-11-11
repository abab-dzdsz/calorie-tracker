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

/* ============================================================
   双设备合并（验收标准：两端各改一条，合并后无丢失、无重复）
   ============================================================ */
function mkDB(over) {
  return Object.assign({
    version: 2,
    profile: { sex: 'male', age: 25, height: 170, weight: 65, activity: 1.375, deficit: 300, goalWeight: null },
    customFoods: [], intakes: [], exercises: [], extras: [], weights: [], ops: [], lastExportAt: null
  }, over);
}
test('合并：两端各加一条记录 → 都保留，无重复（双设备演练）', () => {
  const a = mkDB();
  a.intakes.push({ id: 'a1', date: '2026-10-26', meal: 'lunch', name: 'A设备记录', kcal: 300 });
  const b = mkDB();
  b.intakes.push({ id: 'b1', date: '2026-10-26', meal: 'dinner', name: 'B设备记录', kcal: 500 });
  b.extras.push({ id: 'b2', date: '2026-10-26', name: '步行', kcal: 100 });
  const m = C.mergeDB(a, b);
  assert.strictEqual(m.intakes.length, 2);
  assert.ok(m.intakes.some(r => r.id === 'a1') && m.intakes.some(r => r.id === 'b1'));
  assert.strictEqual(m.extras.length, 1);
  assert.strictEqual(C.mergeDB(m, b).intakes.length, 2, '重复合并不产生重复');
});
test('合并：同 id 记录不重复，自定义食物按名称并集', () => {
  const a = mkDB();
  const rec = { id: 'x1', date: '2026-10-26', meal: 'lunch', name: '同一条', kcal: 100 };
  a.intakes.push(rec);
  a.customFoods.push({ n: '自制菜', k: 200 });
  const b = mkDB();
  b.intakes.push(Object.assign({}, rec));
  b.customFoods.push({ n: '自制菜', k: 200 }, { n: '另一种', k: 150 });
  const m = C.mergeDB(a, b);
  assert.strictEqual(m.intakes.length, 1);
  assert.strictEqual(m.customFoods.length, 2);
});
test('合并：体重同日期冲突 → 较新的 set_weight 操作胜出', () => {
  const a = mkDB();
  a.weights.push({ date: '2026-10-26', kg: 70 });
  a.ops.push({ t: 100, k: 'set_weight', date: '2026-10-26', kg: 70 });
  const b = mkDB();
  b.weights.push({ date: '2026-10-26', kg: 69 });
  b.ops.push({ t: 200, k: 'set_weight', date: '2026-10-26', kg: 69 });
  assert.strictEqual(C.mergeDB(a, b).weights[0].kg, 69, 'B 更新晚 → 取 B');
  assert.strictEqual(C.mergeDB(b, a).weights[0].kg, 69, '合并方向不影响结果');
});
test('合并：新设备（无操作日志）能拿到对方的资料与体重', () => {
  const fresh = mkDB();
  const old = mkDB();
  old.profile.weight = 72.5;
  old.profile.deficit = 400;
  old.weights.push({ date: '2026-10-25', kg: 72.8 });
  old.ops.push({ t: 500, k: 'set_profile', key: 'weight', value: '72.5' });
  old.ops.push({ t: 501, k: 'set_weight', date: '2026-10-25', kg: 72.8 });
  const m = C.mergeDB(fresh, old);
  assert.strictEqual(m.profile.weight, 72.5);
  assert.strictEqual(m.profile.deficit, 400);
  assert.strictEqual(m.weights.length, 1);
});
test('合并：操作日志按时间合并去重，lastExportAt 取较新', () => {
  const a = mkDB();
  a.ops.push({ t: 100, k: 'add_intake' });
  a.lastExportAt = '2026-10-25T10:00:00Z';
  const b = mkDB();
  b.ops.push({ t: 100, k: 'add_intake' }, { t: 300, k: 'clear' });
  b.lastExportAt = '2026-10-26T10:00:00Z';
  const m = C.mergeDB(a, b);
  assert.strictEqual(m.ops.length, 2, '相同操作去重');
  assert.ok(m.ops[0].t <= m.ops[1].t, '按时间有序');
  assert.strictEqual(m.lastExportAt, '2026-10-26T10:00:00Z');
});
test('合并：remote 无效时原样返回，且不修改入参', () => {
  const a = mkDB();
  a.intakes.push({ id: 'z1' });
  const snapshot = JSON.stringify(a);
  assert.strictEqual(C.mergeDB(a, null), a);
  C.mergeDB(a, mkDB());
  assert.strictEqual(JSON.stringify(a), snapshot, 'local 不被修改');
});

/* ============================================================
   轻食决策：营养评分 / 红黄绿 / 硬约束过滤 / 排序 / 调权
   ============================================================ */
const F = n => C.FOODS.find(f => f.n === n || C.baseName(f.n) === n);
test('营养评分：高蛋白低钠高，高钠高脂与含糖饮料低', () => {
  const chest = C.foodScore(F('鸡胸肉')), bro = C.foodScore(F('西兰花'));
  const cola = C.foodScore(F('可乐')), pork = C.foodScore(F('红烧肉'));
  assert.ok(chest >= 70, '鸡胸肉应高分，实际 ' + chest);
  assert.ok(bro >= 85, '西兰花应极高，实际 ' + bro);
  assert.ok(cola <= 55, '可乐应低分，实际 ' + cola);
  assert.ok(pork <= 55, '红烧肉应低分，实际 ' + pork);
});
test('红黄绿：蔬菜水果绿、含糖饮料与高脂大菜橙、精制主食黄', () => {
  assert.strictEqual(C.trafficLight(F('西兰花')), 'green');
  assert.strictEqual(C.trafficLight(F('苹果')), 'green');
  assert.strictEqual(C.trafficLight(F('鸡胸肉')), 'green');
  assert.strictEqual(C.trafficLight(F('可乐')), 'orange');
  assert.strictEqual(C.trafficLight(F('红烧肉')), 'orange');
  assert.strictEqual(C.trafficLight(F('米饭')), 'yellow');
  assert.strictEqual(C.trafficLight(F('杂粮饭')), 'green');
});
test('硬约束：过敏原绝对排除（代码强制，非提示）', () => {
  const ctx = { allergies: ['gl'], conditions: [], capKcal: 9999 };
  assert.strictEqual(C.hardFilter(F('馒头'), ctx), false, '含麸质必须被排除');
  assert.strictEqual(C.hardFilter(F('全麦面包'), ctx), false);
  assert.strictEqual(C.hardFilter(F('米饭'), ctx), true);
});
test('硬约束：疾病阈值（高血压钠≤600 / 控糖碳水≤60 / 控脂）与热量硬顶', () => {
  assert.strictEqual(C.hardFilter(F('麻辣烫'), { allergies: [], conditions: ['hypertension'] }), false, '钠1500>600');
  assert.strictEqual(C.hardFilter(F('米饭'), { allergies: [], conditions: ['hypertension'] }), true);
  assert.strictEqual(C.hardFilter(F('炒饭'), { allergies: [], conditions: ['diabetes'] }), false, '碳水75>60');
  assert.strictEqual(C.hardFilter(F('米饭'), { allergies: [], conditions: ['diabetes'] }), true);
  assert.strictEqual(C.hardFilter(F('红烧肉'), { allergies: [], conditions: ['hyperlipidemia'] }), false, '脂肪供能>50%');
  assert.strictEqual(C.hardFilter(F('火锅'), { allergies: [], conditions: [], capKcal: 300 }), false, '超热量硬顶');
});
test('推荐：高血压画像下所有输出钠≤600，且为 2+1 少决、结果确定性', () => {
  const opts = { foods: C.FOODS, allergies: [], conditions: ['hypertension'], remaining: 1000, gapP: 40, prefs: {}, prefW: {}, recentCls: [], exclude: [], n: 2 };
  const r1 = C.recommend(opts), r2 = C.recommend(opts);
  const all = r1.picks.concat(r1.alt ? [r1.alt] : []);
  assert.ok(all.length >= 2, '应有推荐输出');
  all.forEach(it => assert.ok((+it.food.na || 0) <= 600, it.food.n + ' 钠 ' + it.food.na + ' 超限！'));
  assert.strictEqual(r1.picks.length, 2, '默认 2 个主选（少决）');
  assert.ok(r1.alt, '应有 1 个备选');
  assert.deepStrictEqual(r1.picks.map(p => p.food.n), r2.picks.map(p => p.food.n), '同输入输出必须一致（可审计）');
  assert.strictEqual(r1.filteredOut > 0, true, '应报告被过滤数量');
});
test('换一批：排除已看过的选项后输出变化', () => {
  const base = { foods: C.FOODS, allergies: [], conditions: [], remaining: 1000, gapP: 40, prefs: {}, prefW: {}, recentCls: [], n: 2 };
  const r1 = C.recommend(Object.assign({}, base));
  const seen = r1.picks.map(p => p.food.n);
  const r2 = C.recommend(Object.assign({}, base, { exclude: seen }));
  r2.picks.forEach(p => assert.ok(seen.indexOf(p.food.n) < 0, '换一批不应再出现 ' + p.food.n));
});
test('反馈调权：连续两次「不喜欢」凉食 → 温度权重明显下降且封顶', () => {
  const fish = F('三文鱼'); // 凉
  let w = C.reweight({}, 'skip', fish, 'taste');
  w = C.reweight(w, 'skip', fish, 'taste');
  assert.ok(w['tp:凉'] <= 0.64, '两次后应 ≤0.64，实际 ' + w['tp:凉']);
  for (let i = 0; i < 20; i++) w = C.reweight(w, 'skip', fish, 'taste');
  assert.ok(w['tp:凉'] >= 0.5, '必须有下限 0.5 防止归零，实际 ' + w['tp:凉']);
  const w2 = C.reweight({}, 'pick', fish);
  assert.ok(w2['tp:凉'] > 1, '选它应正向加强');
});
test('周达标率：按有记录天数统计蛋白/纤维/钠', () => {
  const rows = [
    { in: 1800, p: 100, fb: 10, na: 2500 },   // 蛋白达标 钠超标
    { in: 1800, p: 90, fb: 8, na: 1500 },     // 达标 纤维不足
    { in: 0, p: 0, fb: 0, na: 0 },            // 未记录不计
    { in: 1500, p: 40, fb: 2, na: 1200 },     // 蛋白不足 纤维不足
    { in: 1900, p: 95, fb: 30, na: 1800 },    // 达标
    { in: 1600, p: 99, fb: 26, na: 2200 },    // 达标 钠超标
    { in: 1700, p: 96, fb: 5, na: 900 }       // 达标 纤维不足
  ];
  const t = { p: 98, fb: 25, na: 2000 };
  const r = C.weeklyAdherence(rows, t);
  assert.strictEqual(r.withRec, 6);
  assert.strictEqual(r.pOk, 5);
  assert.strictEqual(r.fibLow, 4);
  assert.strictEqual(r.naHigh, 2);
});

/* ============================================================
   一句话录入解析（确认制）：34 条典型句式，目标召回 ≥90%
   ============================================================ */
const NL_CASES = [
  ['半碗米饭', [['米饭', 0.5]], 0], ['一份鸡胸肉', [['鸡胸肉', 1]], 0],
  ['两个鸡蛋', [['鸡蛋', 2]], 0], ['一杯牛奶', [['全脂牛奶', 1]], 0],
  ['一杯酸奶', [['无糖酸奶', 1]], 0], ['250ml牛奶', [['全脂牛奶', 1]], 0],
  ['米饭一碗', [['米饭', 1]], 0], ['两瓶啤酒', [['啤酒', 2]], 0],
  ['奶茶半杯', [['奶茶(全糖)', 0.5]], 0], ['半个苹果', [['苹果', 0.5]], 0],
  ['中午吃了半碗米饭、一份鸡胸肉沙拉', [['米饭', 0.5], ['鸡胸肉', 1]], 0],
  ['早上一个鸡蛋和一杯牛奶', [['鸡蛋', 1], ['全脂牛奶', 1]], 0],
  ['中饭吃了炒饭和可乐', [['炒饭', 1], ['可乐', 1]], 0],
  ['晚上火锅', [['火锅', 1]], 0], ['今天吃了麻辣烫', [['麻辣烫', 1]], 0],
  ['一杯美式咖啡', [['美式咖啡', 1]], 0], ['烤肉吃了烧烤', [['烧烤', 1]], 1],
  ['牛肉面一碗', [['汤面', 1]], 0], ['螺蛳粉一份', [['米线/螺蛳粉', 1]], 0],
  ['肉夹馍加个蛋', [['肉夹馍', 1], ['鸡蛋', 1]], 0], ['两串烧烤', [['烧烤', 2]], 0],
  ['一片全麦面包', [['全麦面包', 1]], 0], ['三片吐司', [['吐司', 3]], 0],
  ['西红柿一个', [['番茄', 1]], 0], ['喝了半杯奶茶', [['奶茶(全糖)', 0.5]], 0],
  ['香蕉一根', [['香蕉', 1]], 0], ['一份沙拉', [['沙拉(含酱)', 1]], 0],
  ['白粥一碗加咸菜', [['白粥', 1]], 1], ['炸鸡腿一个', [['炸鸡腿', 1]], 0],
  ['凉拌豆腐一份', [['豆腐', 1]], 0], ['红薯一个', [['红薯', 1]], 0],
  ['燕麦片40g', [['燕麦片', 1]], 0], ['外卖点了汉堡和薯片', [['汉堡', 1], ['薯片', 1]], 0],
  ['玉米两根', [['玉米', 2]], 0], ['可乐一罐', [['可乐', 1]], 0]
];
test('一句话解析：34 条典型句式召回 ≥90%', () => {
  let hit = 0, fails = [];
  for (const [text, want, wantUnres] of NL_CASES) {
    const r = C.parseNL(text, C.FOODS, C.ALIASES);
    const got = r.items.map(it => [C.baseName(it.name), it.qty]);
    const okItems = want.length === got.length && want.every((w, i) => got[i][0] === w[0] && Math.abs(got[i][1] - w[1]) < 0.001);
    const okUnres = r.unresolved.length === wantUnres;
    if (okItems && okUnres) hit++;
    else fails.push(text + ' → [' + got.map(g => g.join('×')).join(', ') + '] 未识别' + r.unresolved.length + ' 期望 [' + want.map(w => w.join('×')).join(', ') + '] 未识别' + wantUnres);
  }
  assert.strictEqual(fails.length, 0, '未通过 ' + fails.length + ' 条：\n' + fails.join('\n'));
  assert.ok(hit / NL_CASES.length >= 0.9, '召回 ' + hit + '/' + NL_CASES.length);
});
test('一句话解析：确认制契约——只输出候选结构，绝不直接产生入库记录', () => {
  const r = C.parseNL('半碗米饭', C.FOODS, C.ALIASES);
  assert.strictEqual(r.items.length, 1);
  assert.ok(r.items[0].food, '候选必须携带食物对象供回填数值');
  assert.strictEqual(r.items[0].food.k, 230, '数值来自食物库而非解析器');
});
