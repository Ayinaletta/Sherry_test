# 戒指页（/ring）

莹的戒指数据：今天 + 最近 7 天，深色"表盘"风格，点卡片展开细节。页面只给登录后的莹和昀看。

## 数据怎么进来

`POST /api/ring/data`（设备密钥 `X-Device-Secret` 或登录身份），JSON，**所有字段都是可选的**，有什么传什么：

```json
{
  "device": {"model": "COLMI R12", "battery": 81, "firmware": "1.2.3"},
  "synced_at": 1793738066000,
  "samples": [
    {"ts": 1793738000000, "hr": 72, "spo2": 97, "stress": 26, "hrv": 53, "temp": 36.6}
  ],
  "daily": {"date": "2026-11-03", "steps": 5400, "calories": 1240, "distance_m": 3800, "active_min": 42, "goal_steps": 8000},
  "sleep": {
    "start": 1793700000000, "end": 1793727000000,
    "stages": [{"stage": "deep", "start": 1793700000000, "end": 1793703000000}],
    "score": 88
  }
}
```

- `ts` 毫秒或秒都行；同一秒重复上传会去重，所以可以放心重传。
- 睡眠没有分段时可以给 `minutes: {deep, light, rem, awake}` 或只给 `total_min`。`stage` 取 `deep|light|rem|awake`。
- 不给 `score` 时页面按时长/深睡/REM/清醒估一个，并标注"估算"。
- 离谱的值（心率 300、血氧 20 之类）会被丢掉，不会存。
- 每次最多约 1 MB，大批量请分块发（每块 800 条左右）。
- 旧的 iPhone 快捷指令 `POST /api/ring` 还能用，会被转进同一个库。

```bash
curl -X POST https://home.279415.xyz/api/ring/data \
  -H "X-Device-Secret: $SECRET" -H 'Content-Type: application/json' \
  -d '{"samples":[{"ts":'$(date +%s)',"hr":72}]}'
```

## 读取

- `GET /api/ring/summary?days=7[&date=YYYY-MM-DD]`：页面用的汇总
- `GET /api/ring/sleep?date=YYYY-MM-DD`：某一晚的详细分段
- 昀在终端：`home ring`（文字摘要）

## 页面怎么算

- 步数环：目标 `ring_step_goal`（默认 8000），或当天 `goal_steps`。
- 血氧：≥95 正常，90–94 偏低，<90 提醒（提示的是"咨询医生"，不是诊断）。
- 压力：<34 低，<67 中，其余高。
- 体温偏差 / HRV：和"前 14 天的中位数"比，至少 5 天数据才显示基线。戒指没传这两项时，对应卡片不显示。
- 时区：`timezone`（默认 `Europe/Vilnius`），决定"今天"从哪里开始。
- `/ring?demo=1`：不碰服务器的假数据，调样式用。

## 存储

`ring/`（0700，已 gitignore）：`samples.jsonl`、`daily.json`、`sleep.json`、`meta.json`，保留 120 天。

## 还缺的一环

页面和接口都好了，但**还没有人往里送数据**。可选：手机上 Gadgetbridge / 戒指厂商 App 的导出 → Termux 脚本 → 上面的 POST；或 BLE 直连脚本。数据一到，首页"戒指"那一行会自己出现数字。
