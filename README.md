# 减脂热量记录器 v2

减脂期的热量/营养记录 + **体重实测自校准**工具。单页应用、本地优先、离线可用，数据端到端加密后可跨设备同步。

**线上地址**：<https://bejewelled-frangollo-ce7840.netlify.app/>（当前为 v1；v2 部署方式见下）

## 功能

- **记录**：饮食（含蛋白质/脂肪/碳水/纤维/钠，只填热量时按供能比例估算）、零星消耗（手填/按步数）、运动（MET×体重×时长）、体重
- **预算与缺口**：Mifflin-St Jeor BMR → TDEE（活动系数）→ 每日预算 = TDEE − 目标缺口；总消耗 = TDEE + 运动 + 零星
- **营养**：减脂期建议值（蛋白 1.5g/kg、脂肪供能 25%、纤维 25g、钠 ≤2000mg）进度条
- **校准层（自报摄入平均偏差 20–40%，用体重实测纠错）**：
  - 趋势体重（EMA，滤除每日水分波动）
  - 真实消耗反推（体重回归斜率 × 7700 kcal/kg 的能量平衡闭合）
  - 账实核对（预测体重变化 vs 实测，折算每天差多少千卡，提示漏记）
  - 周度评估（按周汇总 + 每周账实差）
- **数据引擎**：schema 版本迁移、结构校验与损坏隔离、localStorage + IndexedDB 双备份、历史快照、操作日志、备份提醒
- **PWA**：Service Worker 离线缓存、可安装、新版本更新横幅
- **同步/备份**：AES-GCM(PBKDF2) 端到端加密导出文件；GitHub 私有 Gist 跨设备同步（上传前自动双向合并，冲突按操作时间解决）

## 本地开发 / 测试

零依赖，Node ≥ 18：

```bash
node --test tests/     # 25 项测试：公式固定用例 + 90天合成数据回归 + 双设备合并演练
python .localserver.py 8765   # 或任意静态服务器；注意 .js 需以 application/javascript 提供
```

结构：

```
index.html            页面与交互（数据引擎/渲染/表单）
core.js               纯计算核心（公式/校准/合并），页面与测试共用
sw.js                 Service Worker（预缓存 + 离线）
manifest.webmanifest  PWA 清单
icon.svg              应用图标
tests/core.test.js    node:test 测试
```

## 部署

- **自动**（推荐）：Netlify 项目关联本仓库后，push 即部署
- **手动**：把整个文件夹（或 5 个根目录文件）拖到 <https://app.netlify.com/drop>

## 隐私

数据只存本机浏览器（localStorage + IndexedDB）与用户自己的云端存储；GitHub/网盘只见加密后的密文。所有数值均为估算，仅供健康管理参考，不构成医疗建议。
