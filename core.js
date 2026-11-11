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

  /* ============================================================
     食物库（带标签）与推荐决策
     标签字段：cls 分类 | al 过敏原(gl麸质 da乳 eg蛋 nu坚果 se海鲜 so大豆)
               fl 口味(清淡/重口/甜) | tp 温度(热/凉) | ef 快手度(1即食/2简烹/3需外卖)
               pr 价格(1低/2中/3高) | sat 饱腹感(1-3) | src 数据来源(cf=中国食物成分表通用估算值)
     评分思路参考 Nutri-Score 营养剖面模型；分类呈现参考 Noom 红黄绿。
     ============================================================ */
  const FOODS = [
  ['米饭 1碗(200g)',230,5,1,52,1,3,'主食',[],'清淡','热',2,1,2],['杂粮饭 1碗(200g)',210,6,2,44,3,3,'主食',[],'清淡','热',2,1,3],['馒头 1个(100g)',220,7,1,46,2,165,'主食',['gl'],'清淡','热',2,1,2],['全麦面包 1片',75,3,1,13,2,120,'主食',['gl'],'清淡','热',1,1,2],['吐司 1片',80,3,2,14,1,130,'主食',['gl'],'清淡','热',1,1,1],
  ['汤面 1碗',320,10,6,55,2,700,'主食',['gl'],'清淡','热',3,2,2],['炒面 1份',500,12,18,70,3,900,'主食',['gl'],'重口','热',3,2,2],['炒饭 1份',520,11,17,75,2,800,'主食',[],'重口','热',3,2,2],['白粥 1碗',140,3,1,30,0,5,'主食',[],'清淡','热',2,1,1],['燕麦片 40g(干)',150,6,3,26,4,3,'主食',[],'清淡','热',1,1,3],
  ['红薯 1个(200g)',170,3,0,40,3,55,'主食',[],'清淡','热',2,1,3],['蒸土豆 100g',80,2,0,17,1,3,'主食',[],'清淡','热',2,1,2],['玉米 1根',110,4,1,23,3,2,'主食',[],'清淡','热',1,1,2],['饺子 10个',420,17,18,47,2,700,'主食',['gl'],'清淡','热',3,2,3],['肉包 1个',230,8,9,29,1,400,'主食',['gl'],'清淡','热',3,2,2],
  ['油条 1根',230,4,13,25,1,350,'主食',['gl'],'重口','热',3,1,1],['煎饼果子 1份',450,12,18,58,2,800,'主食',['gl','eg'],'重口','热',3,2,2],['三明治 1个',320,14,12,38,2,700,'主食',['gl'],'清淡','凉',1,2,2],['汉堡 1个',480,20,24,45,2,800,'主食',['gl'],'重口','热',3,2,2],['披萨 1块',285,12,10,35,2,640,'主食',['gl','da'],'重口','热',3,3,2],
  ['鸡蛋 1个',75,7,6,1,0,70,'蛋白',['eg'],'清淡','热',1,1,2],['鸡胸肉 100g',130,24,4,1,0,60,'蛋白',[],'清淡','热',2,2,3],['猪瘦肉 100g',145,21,7,1,0,55,'蛋白',[],'清淡','热',2,2,3],['红烧肉 100g',470,14,45,6,0,550,'蛋白',[],'重口','热',3,3,2],['牛瘦肉 100g',125,22,4,2,0,60,'蛋白',[],'清淡','热',2,3,3],
  ['虾仁 100g',90,18,1,1,0,170,'蛋白',['se'],'清淡','热',2,3,3],['清蒸鱼 100g',120,18,5,1,0,250,'蛋白',['se'],'清淡','热',3,3,3],['三文鱼 100g',140,20,7,0,0,55,'蛋白',['se'],'清淡','凉',2,3,3],['豆腐 100g',80,8,5,2,0,10,'蛋白',['so'],'清淡','热',2,1,2],['豆腐干 100g',150,16,8,4,1,400,'蛋白',['so'],'清淡','凉',1,1,2],
  ['酸奶(含糖) 1杯',130,5,4,17,0,60,'饮品',['da'],'甜','凉',1,2,1],['无糖酸奶 1杯',80,5,4,6,0,55,'饮品',['da'],'清淡','凉',1,2,2],['全脂牛奶 1杯(250ml)',160,8,9,13,0,110,'饮品',['da'],'清淡','凉',1,1,2],['脱脂牛奶 1杯(250ml)',90,9,0,13,0,110,'饮品',['da'],'清淡','凉',1,1,1],['无糖豆浆 1杯',80,7,4,3,1,3,'饮品',['so'],'清淡','热',1,1,1],
  ['西兰花 100g',35,3,0,5,3,20,'蔬菜',[],'清淡','热',2,1,1],['白灼蔬菜 100g',25,2,0,4,2,30,'蔬菜',[],'清淡','凉',2,1,1],['炒青菜 1份',130,3,10,6,3,400,'蔬菜',[],'清淡','热',2,1,1],['黄瓜 1根',20,1,0,4,1,5,'蔬菜',[],'清淡','凉',1,1,1],['番茄 1个',25,1,0,5,1,5,'蔬菜',[],'清淡','凉',1,1,1],
  ['苹果 1个',85,0,0,21,4,2,'水果',[],'清淡','凉',1,1,2],['香蕉 1根',105,1,0,25,3,1,'水果',[],'清淡','凉',1,1,2],['橙子 1个',70,1,0,16,3,1,'水果',[],'清淡','凉',1,1,1],['西瓜 100g',30,1,0,7,0,3,'水果',[],'清淡','凉',1,1,1],['蓝莓 100g',60,1,0,14,3,1,'水果',[],'清淡','凉',1,3,1],
  ['拿铁 1杯(中杯)',150,8,6,14,0,90,'饮品',['da'],'清淡','热',3,3,1],['美式咖啡 1杯',10,0,0,2,0,5,'饮品',[],'清淡','热',2,2,1],['奶茶(全糖) 1杯',400,3,10,68,0,90,'饮品',['da'],'甜','凉',3,2,1],['可乐 1罐(330ml)',140,0,0,35,0,10,'饮品',[],'甜','凉',1,1,1],['无糖可乐 1罐',0,0,0,0,0,10,'饮品',[],'清淡','凉',1,1,1],
  ['啤酒 1瓶(500ml)',215,2,0,17,0,10,'饮品',[],'重口','凉',1,2,1],['红酒 1杯(150ml)',125,0,0,4,0,6,'饮品',[],'重口','凉',1,3,1],['白酒 1两',175,0,0,0,0,3,'饮品',[],'重口','凉',1,3,1],
  ['坚果 25g',150,5,13,5,3,100,'零食',['nu'],'清淡','凉',1,2,2],['薯片 1包(30g)',160,2,10,16,1,180,'零食',[],'重口','凉',1,1,1],['巧克力 25g',140,2,9,15,1,25,'零食',['da'],'甜','凉',1,2,1],['冰淇淋 1支',150,3,7,20,0,55,'零食',['da','eg'],'甜','凉',1,2,1],['蛋糕 1块',300,5,15,37,1,200,'零食',['gl','da','eg'],'甜','凉',3,2,1],['饼干 4片',120,2,5,17,1,120,'零食',['gl'],'甜','凉',1,1,1],
  ['麻辣烫 1碗',450,20,25,35,4,1500,'混合',['so'],'重口','热',3,2,2],['火锅 1顿',800,35,50,40,5,1800,'混合',[],'重口','热',3,3,3],['烧烤 1顿',700,35,40,30,2,1600,'混合',[],'重口','热',3,3,2],['沙拉(含酱) 1份',250,8,15,18,5,450,'混合',[],'清淡','凉',1,2,2],['卤鸡腿 1个',190,20,10,4,0,600,'蛋白',[],'重口','热',2,1,2],['炸鸡腿 1个',280,18,17,12,1,550,'蛋白',[],'重口','热',3,1,2],
  ['米线/螺蛳粉 1碗',450,10,15,68,2,1300,'主食',[],'重口','热',3,2,2],['肉夹馍 1个',400,15,16,48,2,700,'主食',['gl'],'重口','热',3,2,2]
  ].map(([n,k,p,f,c,fb,na,cls,al,fl,tp,ef,pr,sat])=>({n:n,k:k,p:p,f:f,c:c,fb:fb,na:na,cls:cls,al:al,fl:fl,tp:tp,ef:ef,pr:pr,sat:sat,src:'cf'}));
  const EXERCISES=[
  ['散步(慢走)',3],['快走',5],['慢跑(6–8km/h)',8],['跑步(10km/h)',10],['骑自行车(休闲)',6],['骑自行车(快速)',8],
  ['游泳',8],['跳绳',10],['瑜伽',3],['普拉提',3.5],['力量训练',5],['椭圆机',5],['有氧操',6],['跳舞',5],
  ['爬楼梯',8],['爬山/徒步',6],['羽毛球',5.5],['篮球',6.5],['乒乓球',4],['家务',3]
  ].map(([n,met])=>({n:n,met:met}));
  // 常见口语别名 → 食物库标准名（确认制录入用）
  const ALIASES={'米饭':'米饭','面条':'汤面','粥':'白粥','稀饭':'白粥','燕麦':'燕麦片','麦片':'燕麦片','地瓜':'红薯','土豆':'蒸土豆','包子':'肉包','煎饼':'煎饼果子','蛋':'鸡蛋','鸡肉':'鸡胸肉','瘦肉':'猪瘦肉','猪肉':'猪瘦肉','牛肉':'牛瘦肉','牛肉面':'汤面','虾':'虾仁','鱼':'清蒸鱼','豆干':'豆腐干','酸奶':'无糖酸奶','牛奶':'全脂牛奶','豆浆':'无糖豆浆','青菜':'炒青菜','蔬菜':'白灼蔬菜','西红柿':'番茄','咖啡':'美式咖啡','奶茶':'奶茶(全糖)','雪糕':'冰淇淋','沙拉':'沙拉(含酱)','鸡腿':'卤鸡腿','炸鸡':'炸鸡腿','米线':'米线/螺蛳粉','螺蛳粉':'米线/螺蛳粉','全麦面包':'全麦面包','面包':'全麦面包','红肉':'红烧肉'};

  function baseName(n){const i=n.indexOf(' ');return i>0?n.slice(0,i):n;}
  function findFoodByName(text,foods,aliases){ // 最长匹配；返回 {food, partial} 或 null
    if(!text)return null;
    const byBase={};
    for(const f of foods){byBase[f.n]=f;const b=baseName(f.n);if(!byBase[b])byBase[b]=f;}
    if(byBase[text])return {food:byBase[text],partial:false};
    if(aliases[text]&&byBase[aliases[text]])return {food:byBase[aliases[text]],partial:false};
    let best=null;
    for(const key in byBase){if(key.length>=2&&text.indexOf(key)>=0&&(!best||key.length>best.length))best=key;}
    for(const a in aliases){if(a.length>=2&&text.indexOf(a)>=0&&(!best||a.length>best.length)){best=a;var viaAlias=aliases[a];}}
    if(best)return {food:byBase[viaAlias||best],partial:true};
    return null;
  }
  /* 一句话录入解析（规则版，确认制：解析结果必须经用户确认才入库） */
  function parseNL(text,foods,aliases){
    const res={items:[],unresolved:[]};
    if(!text||!text.trim())return res;
    const NUM={'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'半':0.5};
    let s=text.replace(/(今天|昨天|早上|中午|晚上|上午|下午|夜宵|早餐|午餐|晚餐|早饭|午饭|晚饭|中饭|吃了|吃|喝了|喝|点了|点|来个|来份|来了|来|要了|要|记一下|记录|外卖|大概|大约|差不多|一共|总共|而且|然后|另外|还有|刚刚|刚|先)/g,'|');
    const segs=s.split(/\||、|，|,|。|;|；|\+|\n|和|加|跟|又/);
    for(const raw of segs){
      let seg=raw.trim();if(!seg)continue;
      let qty=1,consumed=false,mm;
      // 前置数量："半碗米饭""两个鸡蛋""250ml牛奶"
      if((mm=seg.match(/^(半|[0-9]*\.?[0-9]+|[一二三四五六七八九十]+|两)(大杯|中杯|小杯|大份|小份|碗|份|个|杯|瓶|罐|根|块|片|包|盒|支|串|颗|枚|克|g|G|ml|毫升|斤|两)?/))){
        const num=mm[1],unit=mm[2]||'';
        if(num.indexOf('两')>=0)qty=(num==='两')?2:(NUM[num[0]]||1);
        else if(num==='半')qty=0.5;
        else if(/^[0-9]/.test(num))qty=parseFloat(num);
        else if(num.length===1)qty=NUM[num]||1;
        else if(num.indexOf('十')===0)qty=10+(NUM[num[1]]||0);
        else if(num.indexOf('十')===num.length-1)qty=(NUM[num[0]]||1)*10;
        else qty=(NUM[num[0]]||1)*10+(NUM[num[1]]||0);
        if(/^(克|g|G|ml|毫升|斤)$/.test(unit)&&qty>20)qty=1; // 按重量描述按 1 份入库
        seg=seg.slice(mm[0].length);consumed=true;
      }
      // 尾置数量："米饭一碗""西红柿一个""玉米两根"
      if(!consumed||(consumed&&!seg.replace(/^[个只条份颗枚]/,''))){
        let t=seg.replace(/^[个只条份颗枚]/,'');
        if((mm=t.match(/(半|[0-9]*\.?[0-9]+|[一二两三四五六七八九十]+)\s*(大杯|中杯|小杯|碗|份|个|杯|瓶|罐|根|块|片|包|盒|支|串|颗|枚|克|g|G|ml|毫升|斤|两)?$/))&&mm.index>0){
          const num=mm[1],unit=mm[2]||'';
          if(num.indexOf('两')>=0)qty=(num==='两')?2:(NUM[num[0]]||1);
          else if(num==='半')qty=0.5;
          else if(/^[0-9]/.test(num))qty=parseFloat(num);
          else if(num.length===1)qty=NUM[num]||1;
          else if(num.indexOf('十')===num.length-1)qty=(NUM[num[0]]||1)*10;
          else qty=(NUM[num[0]]||1)*10+(NUM[num[1]]||0);
          if(/^(克|g|G|ml|毫升|斤)$/.test(unit)&&qty>20)qty=1;
          seg=(t.slice(0,mm.index)+t.slice(mm.index+mm[0].length)).trim();
        } else seg=t;
      } else seg=seg.replace(/^[个只条份颗枚]/,'');
      seg=seg.replace(/的$/,'').trim();
      if(!seg)continue;
      const hit=findFoodByName(seg,foods,aliases);
      if(hit)res.items.push({name:hit.food.n,food:hit.food,qty:qty,partial:hit.partial,raw:raw.trim()});
      else res.unresolved.push(raw.trim());
    }
    return res;
  }

  /* ---- 营养评分 0-100（Nutri-Score 式剖面：正=蛋白/纤维/类别，负=钠密度/脂肪供能/能量） ---- */
  function foodScore(f){
    const k=+f.k||0;
    if(!(k>0))return f.cls==='饮品'?55:40; // 无热量饮品（无糖可乐）
    const p=+f.p||0,na=+f.na||0,fb=+f.fb||0,fl=+f.f||0;
    let s=60;
    s+=Math.min(25,(Math.min(p*4/k,0.4))*62.5);              // 蛋白供能占比（40% 封顶）
    s+=Math.min(15,(fb*1000/k)/2.5*15);                       // 纤维密度（每100kcal 2.5g 封顶）
    s-=Math.min(20,(na/k)/2.5*20);                            // 钠密度（每100kcal 250mg 封顶罚满）
    const fc=fl*9/k;
    s-=Math.min(15,Math.max(0,fc-0.2)*50);                    // 脂肪供能超 20% 起罚
    const adj={'蔬菜':10,'水果':8,'蛋白':5,'零食':-8,'混合':-3,'饮品':((+f.c||0)>10?-6:0),'主食':0};
    s+=(adj[f.cls]!=null?adj[f.cls]:0);
    return Math.max(0,Math.min(100,Math.round(s)));
  }
  /* 红黄绿分类（Noom 式）：green 放心 / yellow 适量 / orange 限制 */
  function trafficLight(f){
    const s=foodScore(f),k=Math.max(+f.k||1,1),fc=(+f.f||0)*9/k;
    if(f.cls==='蔬菜'||f.cls==='水果')return 'green';
    if(f.cls==='饮品'&&((+f.c||0)>10||f.fl==='甜'))return 'orange';
    if(f.cls==='零食'&&s<60)return 'orange';
    if(fc>0.45&&k>=200)return 'orange';
    if(f.cls==='主食'&&(f.fb||0)<=2&&s<90)return 'yellow';
    if(s>=65)return 'green';
    if(s>=40)return 'yellow';
    return 'orange';
  }
  /* 硬约束过滤：过敏原 / 疾病阈值 / 热量硬顶 —— 代码强制，不依赖概率性服从 */
  function hardFilter(f,ctx){
    if(ctx.allergies&&ctx.allergies.length&&(f.al||[]).some(a=>ctx.allergies.indexOf(a)>=0))return false;
    const C=ctx.conditions||[],k=Math.max(+f.k||1,1);
    if(C.indexOf('hypertension')>=0&&(+f.na||0)>600)return false;        // 单项钠上限
    if(C.indexOf('diabetes')>=0&&(+f.c||0)>60)return false;              // 单项碳水上限
    if(C.indexOf('hyperlipidemia')>=0&&k>=150&&(fl9(f))>0.5)return false; // 高脂供能占比
    if(ctx.capKcal&&k>ctx.capKcal)return false;
    return true;
  }
  function fl9(f){return ((+f.f||0)*9)/Math.max(+f.k||1,1);}
  /* 排序：五维加权 + 近3天重复惩罚 + 反馈调权乘子。确定性（并列按名称）。 */
  function rankFoods(cands,ctx){
    const W=ctx.prefW||{};
    const wm=key=>{const v=W[key];return v==null?1:Math.max(0.5,Math.min(1.3,v));};
    const prefs=ctx.prefs||{};
    const recent=ctx.recentCls||[];
    return cands.map(f=>{
      const k=+f.k||0,p=+f.p||0;
      const parts={
        score:foodScore(f)/100,
        proteinGap:ctx.gapP>0?Math.min(1,p/Math.max(ctx.gapP,1)):0.5,
        light:(f.fl==='清淡'?1:0)*((prefs.light||0)/5),
        satiety:((f.sat||1)/3)*((prefs.satiety||0)/5),
        cheap:(f.pr===1?1:(f.pr===2?0.5:0))*((prefs.cheap||0)/5),
        quick:(f.ef<=2?1:0)*((prefs.quick||0)/5)
      };
      let s=0.34*parts.score+0.30*parts.proteinGap+0.14*parts.light+0.10*parts.satiety+0.06*parts.cheap+0.06*parts.quick;
      const ri=recent.indexOf(f.cls);
      if(ri>=0)s*=1-ri*0.3;                                  // 近3天重复惩罚
      s*=wm('fl:'+f.fl)*wm('tp:'+f.tp)*wm('cls:'+f.cls)*wm('ef:'+f.ef)*wm('pr:'+String(f.pr));
      return {food:f,s:+s.toFixed(4),parts:parts};
    }).sort((a,b)=>b.s-a.s||(a.food.n<b.food.n?-1:1));
  }
  /* 推荐：少决原则——默认 2 个主选 + 1 个备选，每个带解释 */
  function recommend(opts){
    const all=opts.foods||[];
    const cap=Math.max(120,Math.round(opts.remaining*1.1));
    const cands=all.filter(f=>hardFilter(f,{allergies:opts.allergies,conditions:opts.conditions,capKcal:cap})
      &&!(opts.exclude||[]).some(x=>x===f.n||x===baseName(f.n)));
    const ranked=rankFoods(cands,opts);
    const n=opts.n||2;
    const picks=ranked.slice(0,n);
    return {picks:picks,alt:ranked[n]||null,shown:picks.length,filteredOut:all.length-cands.length,total:all.length};
  }
  /* 反馈调权：归因 → 权重乘子（0.5–1.3 区间），记录可解释可审计 */
  function reweight(prefW,action,food,reason){
    const out=Object.assign({},prefW||{});
    const bump=(key,d)=>{const cur=out[key]==null?1:out[key];out[key]=+Math.max(0.5,Math.min(1.3,cur*d)).toFixed(3);};
    if(action==='pick'){bump('fl:'+(food.fl||''),1.05);bump('tp:'+(food.tp||''),1.05);bump('cls:'+(food.cls||''),1.05);return out;}
    if(reason==='price')bump('pr:'+String(food.pr),0.85);
    else if(reason==='time')bump('ef:'+String(food.ef),0.85);
    else if(reason==='taste'){bump('fl:'+(food.fl||''),0.8);bump('tp:'+(food.tp||''),0.8);}
    else if(reason==='repeat')bump('cls:'+(food.cls||''),0.85);
    else if(reason==='other')bump('cls:'+(food.cls||''),0.95);
    return out;
  }
  /* 周达标率（Cronometer 式周报思路）：蛋白达标天数 / 纤维不足天数 / 钠超标天数 */
  function weeklyAdherence(rows,targets){
    if(!targets)return null;
    let pOk=0,fibLow=0,naHigh=0,withRec=0;
    for(const r of rows||[]){
      if(!r||!(+r.in>0))continue;
      withRec++;
      if((+r.p||0)>=targets.p*0.8)pOk++;
      if((+r.fb||0)<20)fibLow++;
      if((+r.na||0)>2000)naHigh++;
    }
    return {pOk:pOk,fibLow:fibLow,naHigh:naHigh,withRec:withRec};
  }

  const CalCore = {
    KCAL_PER_KG: KCAL_PER_KG,
    calcBmr: calcBmr, calcTdee: calcTdee, calcBudget: calcBudget,
    exKcal: exKcal, stepsKcal: stepsKcal,
    estimateMacros: estimateMacros, nutritionTargets: nutritionTargets,
    emaTrend: emaTrend, weightSlope: weightSlope,
    estimateRealTdee: estimateRealTdee, ledgerCheck: ledgerCheck,
    weeklyBlocks: weeklyBlocks, mergeDB: mergeDB,
    FOODS: FOODS, EXERCISES: EXERCISES, ALIASES: ALIASES,
    baseName: baseName, findFoodByName: findFoodByName,
    parseNL: parseNL, foodScore: foodScore, trafficLight: trafficLight,
    hardFilter: hardFilter, rankFoods: rankFoods, recommend: recommend,
    reweight: reweight, weeklyAdherence: weeklyAdherence,
    niceStep: niceStep, niceCeil: niceCeil, niceFloor: niceFloor, niceTicks: niceTicks
  };
  root.CalCore = CalCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = CalCore;
})(typeof self !== 'undefined' ? self : globalThis);
