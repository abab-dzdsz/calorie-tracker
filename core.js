'use strict';
/* ============================================================
   减脂热量记录器 · 纯计算核心（无 DOM 依赖）
   供 index.html 与 tests/core.test.js 共用。
   所有函数只依赖入参；公式出处见各函数注释。
   ============================================================ */
(function (root) {
  // Wishnofsky (1958) 线性近似：约 7700 千卡 ≈ 1kg 脂肪。
  // 注意：这是近似值，大缺口/长期会因代谢适应失真，因此 app 用体重实测做账实核对。
  const KCAL_PER_KG = 7700;

  /* ---- 基础能量公式 ---- */

  // Mifflin-St Jeor (1990, Am J Clin Nutr)：BMR = 10W + 6.25H − 5A (男 +5 / 女 −161)
  function calcBmr(p) {
    if (!(p && p.weight > 0 && p.height > 0 && p.age > 0)) return 0;
    const base = 10 * p.weight + 6.25 * p.height - 5 * p.age;
    return Math.round(p.sex === 'female' ? base - 161 : base + 5);
  }
  // TDEE = BMR × 活动系数（1.2 / 1.375 / 1.55 / 1.725）
  function calcTdee(p) { return Math.round(calcBmr(p) * (+p.activity || 1.2)); }
  // 每日摄入预算 = TDEE − 目标缺口
  function calcBudget(p) { return calcTdee(p) - Math.max(0, +p.deficit || 0); }

  // 运动消耗 ≈ MET × 体重kg × 小时（《体力活动概要》Ainsworth 2011）
  function exKcal(met, kg, min) { return (met > 0 && kg > 0 && min > 0) ? Math.round(met * kg * min / 60) : 0; }
  // 步数消耗粗估：每步每公斤体重约 0.0005 千卡
  function stepsKcal(steps, kg) { return (steps > 0 && kg > 0) ? Math.round(steps * 0.0005 * kg) : 0; }

  // 只填热量时按常见供能比例估算宏量营养：蛋白 15% · 脂肪 30% · 碳水 55%
  function estimateMacros(kcal) {
    const k = +kcal || 0;
    return {
      p: Math.round(k * 0.15 / 4 * 10) / 10,
      f: Math.round(k * 0.30 / 9 * 10) / 10,
      c: Math.round(k * 0.55 / 4 * 10) / 10,
      est: true
    };
  }

  // 减脂期营养建议值：蛋白 1.5 g/kg（可接受 1.2–2.0）· 脂肪供能 25%（20–30%）· 纤维 25g · 钠 ≤2000mg
  function nutritionTargets(weight, budget) {
    const w = +weight || 0, b = +budget || 0;
    if (!(w > 0) || !(b > 0)) return null;
    const p = Math.round(w * 1.5);
    const f = Math.round(b * 0.25 / 9);
    const c = Math.max(0, Math.round((b - p * 4 - f * 9) / 4));
    return { p: p, f: f, c: c, fb: 25, na: 2000 };
  }

  /* ---- 校准层：让体重实测给公式纠错 ---- */

  // 趋势体重（Hacker's Diet 的 EMA）：trend = trend + α×(秤值 − trend)，α=0.1。
  // 输入 [{date:'YYYY-MM-DD', kg}]，返回按日期升序、带 trend 字段的新数组。
  function emaTrend(weights, alpha) {
    const a = alpha || 0.1;
    const ws = (weights || []).slice().sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    let t = null;
    const out = [];
    for (const w of ws) {
      t = (t == null) ? +w.kg : t + a * (+w.kg - t);
      out.push({ date: w.date, kg: +w.kg, trend: t });
    }
    return out;
  }

  /* 区间 [startDS, endDS] 内的体重变化速度。
     不用 EMA 首尾点（滤波滞后会低估快速变化），而是对区间内全部称重点
     做最小二乘回归取斜率——这是能量平衡法的标准做法，能把单日水分噪声平均掉。
     返回 { slope: kg/day, n: 称重次数 }；少于 2 次称重返回 null。 */
  function dNum(ds) {
    const a = ds.split('-').map(Number);
    return Date.UTC(a[0], a[1] - 1, a[2]) / 86400000;
  }
  function weightSlope(weights, startDS, endDS) {
    const pts = (weights || [])
      .filter(w => w.date >= startDS && w.date <= endDS && isFinite(+w.kg))
      .map(w => ({ x: dNum(w.date), y: +w.kg }))
      .sort((a, b) => a.x - b.x);
    if (pts.length < 2) return null;
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n;
    const my = pts.reduce((s, p) => s + p.y, 0) / n;
    let sxy = 0, sxx = 0;
    for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) * (p.x - mx); }
    if (!(sxx > 0)) return null;
    return { slope: sxy / sxx, n: n };
  }

  /* 能量平衡闭合：用实测体重反推真实消耗。
     每日平衡：摄入 − 总消耗 = 身体储能变化 = 斜率×7700（千卡/天，斜率为 kg/day）
     输入：
       avgIntake     有饮食记录天的平均摄入（千卡）
       slopeKgPerDay 区间体重回归斜率（kg/day，负=在变轻）
       avgBurnRec    有饮食记录天的平均(零星+运动)消耗（千卡）
     输出：{ realTotal, realBase }
       realTotal = avgIntake − slope×7700   （真实每日总消耗均值）
       realBase  = realTotal − avgBurnRec    （反推的基础消耗，可与公式 TDEE 对比）
     数据不足返回 null。 */
  function estimateRealTdee(o) {
    const avgIntake = +o.avgIntake || 0;
    if (!(avgIntake > 0)) return null;
    if (o.slopeKgPerDay == null || !isFinite(o.slopeKgPerDay)) return null;
    const realTotal = avgIntake - o.slopeKgPerDay * KCAL_PER_KG;
    const realBase = realTotal - (+o.avgBurnRec || 0);
    return { realTotal: Math.round(realTotal), realBase: Math.round(realBase) };
  }

  /* 账实核对：按记录预测的体重变化 vs 实测趋势变化。
     predKg   按记录缺口预测的体重变化（kg，负=应变轻）
     actualKg 实测趋势变化（kg）
     gapKg = actual − pred：> 0 表示"比预测少减了"（典型原因：漏记/低估摄入），
             < 0 表示"比预测多减了"。
     gapKcal 把体重差折算成每天多少千卡。|gap| ≤0.4kg good / ≤1kg warn / 更大 bad。 */
  function ledgerCheck(o) {
    const days = +o.days || 0;
    if (!(days >= 7) || o.predKg == null || o.actualKg == null || !isFinite(o.predKg) || !isFinite(o.actualKg)) return null;
    const gapKg = o.actualKg - o.predKg;
    const gapKcal = Math.round(gapKg * KCAL_PER_KG / days);
    let cls = 'good';
    if (Math.abs(gapKg) > 1.0) cls = 'bad';
    else if (Math.abs(gapKg) > 0.4) cls = 'warn';
    return { gapKg: Math.round(gapKg * 100) / 100, gapKcal: gapKcal, cls: cls };
  }

  // 把日期区间切成 7 天块（首块对齐区间起点，末块不足 4 天并入前一块）
  function weeklyBlocks(days) {
    if (!days || !days.length) return [];
    const blocks = [];
    for (let i = 0; i < days.length; i += 7) {
      const seg = days.slice(i, i + 7);
      if (seg.length < 4 && blocks.length) blocks[blocks.length - 1] = blocks[blocks.length - 1].concat(seg);
      else blocks.push(seg);
    }
    return blocks;
  }

  /* ---- 双设备合并（Gist 同步用，纯函数、确定性） ----
     原则：
     · 带记录（intakes/exercises/extras）按 id 取并集——id 唯一，天然无冲突
     · 体重按日期，自定义食物按名称并集
     · 体重同日期 / 资料同字段冲突时：取「较新的写操作」一侧（依据双方 ops 日志）；
       对方有操作记录而本机没有（如新设备）则取对方；两边都无记录则保守保留本地
     · 操作日志按时间排序合并去重（上限 800 条）
     返回合并后的新对象，不修改入参。 */
  function lastOpTime(d, kind, pred) {
    let t = -1;
    for (const o of (d && d.ops) || []) {
      if (o && o.k === kind && (!pred || pred(o)) && typeof o.t === 'number') t = Math.max(t, o.t);
    }
    return t;
  }
  function mergeDB(local, remote) {
    if (!remote || typeof remote !== 'object') return local;
    const out = JSON.parse(JSON.stringify(local));
    for (const key of ['intakes', 'exercises', 'extras']) {
      const seen = new Set((out[key] || []).map(r => r.id));
      for (const r of remote[key] || []) if (!seen.has(r.id)) (out[key] = out[key] || []).push(r);
    }
    const names = new Set((out.customFoods || []).map(f => f.n));
    for (const f of remote.customFoods || []) if (!names.has(f.n)) (out.customFoods = out.customFoods || []).push(f);
    for (const w of remote.weights || []) {
      const i = out.weights.findIndex(x => x.date === w.date);
      if (i < 0) out.weights.push(w);
      else {
        const lt = lastOpTime(local, 'set_weight', o => o.date === w.date);
        const rt = lastOpTime(remote, 'set_weight', o => o.date === w.date);
        if (rt > lt) out.weights[i] = w;
      }
    }
    const localTouched = (local.ops || []).some(o => o && o.k === 'set_profile');
    const remoteTouched = (remote.ops || []).some(o => o && o.k === 'set_profile');
    for (const key in remote.profile || {}) {
      if (!(key in out.profile)) continue;                       // 未知字段不合并
      if (remote.profile[key] == null && out.profile[key] != null) continue; // 空值不覆盖
      const lt = lastOpTime(local, 'set_profile', o => o.key === key);
      const rt = lastOpTime(remote, 'set_profile', o => o.key === key);
      // 本机从没改过资料而对方改过（如新设备首次合并）→ 整体采纳对方资料；
      // 两边都改过 → 按各字段较新的写操作
      if (rt > lt || (rt >= 0 && lt < 0) || (remoteTouched && !localTouched)) out.profile[key] = remote.profile[key];
    }
    const sig = new Set((out.ops || []).map(o => JSON.stringify(o)));
    for (const o of remote.ops || []) {
      const s = JSON.stringify(o);
      if (!sig.has(s)) { sig.add(s); out.ops.push(o); }
    }
    out.ops.sort((a, b) => (a.t || 0) - (b.t || 0));
    if (out.ops.length > 800) out.ops.splice(0, out.ops.length - 800);
    if (remote.lastExportAt && (!out.lastExportAt || new Date(remote.lastExportAt) > new Date(out.lastExportAt))) {
      out.lastExportAt = remote.lastExportAt;
    }
    out.version = Math.max(out.version || 2, remote.version || 2);
    return out;
  }

  /* ---- 图表刻度（取"好看"的步长） ---- */
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }
  function niceCeil(v) { if (!(v > 0)) return 0; const s = niceStep(v); return Math.ceil(v / s) * s; }
  function niceFloor(v) { if (!(v > 0)) return 0; const s = niceStep(v); return Math.floor(v / s) * s; }
  function niceTicks(min, max) {
    const step = niceStep((max - min) / 4 || 1);
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(4));
    return out.length ? out : [min, max];
  }

  const CalCore = {
    KCAL_PER_KG: KCAL_PER_KG,
    calcBmr: calcBmr, calcTdee: calcTdee, calcBudget: calcBudget,
    exKcal: exKcal, stepsKcal: stepsKcal,
    estimateMacros: estimateMacros, nutritionTargets: nutritionTargets,
    emaTrend: emaTrend, weightSlope: weightSlope,
    estimateRealTdee: estimateRealTdee, ledgerCheck: ledgerCheck,
    weeklyBlocks: weeklyBlocks, mergeDB: mergeDB,
    niceStep: niceStep, niceCeil: niceCeil, niceFloor: niceFloor, niceTicks: niceTicks
  };
  root.CalCore = CalCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = CalCore;
})(typeof self !== 'undefined' ? self : globalThis);
