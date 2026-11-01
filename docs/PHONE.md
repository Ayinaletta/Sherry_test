# 红米：让昀自己醒来就能用手机

写给 VPS 上的昀。新家这一半已经做好；手机上的脚本是**模板**，写的时候没有真机，请你在手机上逐个试过再信它。

## 现状
```
昀(VPS) ──https──▶ phone.279415.xyz ──cloudflared──▶ 手机 Termux :8766  walnut shim (/v1/* 和 /mcp)
手机 ──▶ home.279415.xyz  ← 截图 /api/phone/screen，心跳 /api/phone/heartbeat，动作 /api/phone/activity（设备口令）
```
莹的情况：锁屏有 PIN（保留）；不是一直插电（她会在 20% 前充电）；手机基本不重启；**但 Termux 常常"看着在后台，点进去却是新的"**。

## 真正的对手：Termux 被系统悄悄杀掉
Termux 被杀 → 里面的 cloudflared、shim、心跳一起没了 → 手机在线、你却连不上。Termux:Boot 只在**开机**时拉起它们，所以这种情况谁也不会去修，要等莹点开 Termux。

怎么确认：新家的 `/phone` 页和 `tools/home.sh phone` 会显示"Termux 过去 7 天重启 N 次"（心跳里的 `started_at` 变了就算一次）。N 不为 0，说明就是这个问题。

### 减少被杀（在手机上，一次性）
1. **Android 12 的"幽灵进程杀手"**：它会成批杀掉 App 的子进程，正是 Termux 的症状。用 adb/rish 执行（Termux 官方 wiki 有说明；**以你在 12C 上的实际效果为准**）：
   ```
   device_config set_sync_disabled_for_tests persistent
   device_config put activity_manager max_phantom_processes 2147483647
   settings put global settings_enable_monitor_phantom_procs false
   ```
2. **MIUI**：设置 → 应用 → 管理应用 → Termux、Termux:Boot、Termux:API：「自启动」开；「省电策略」选「无限制」；在多任务界面把 Termux **锁定**（长按卡片出现锁）。
3. Termux 通知栏里的 **Acquire wakelock** 保持开着（`termux-wake-lock`），那条常驻通知不要划掉。
4. 电量别让它掉到 15% 以下：省电模式会优先杀后台。新家会在 **25%** 时提醒莹充电（`phone_low_battery` 可调）。

### 被杀了之后自己回来
- `public/phone_watchdog.sh`：检查 cloudflared、shim、心跳有没有在跑，缺哪个补哪个。用 Android 自己的任务调度器每 15 分钟跑一次（它不依赖 Termux 活着）：
  ```
  termux-job-scheduler --job-id 77 --script "$HOME/phone_watchdog.sh" --period-ms 900000 --persisted true --network any
  ```
  再从 `~/.termux/boot/` 在开机时跑一次。**请自己试：手动杀掉 cloudflared，再运行它，看它回来。**（15 分钟是 Android 允许的最短周期。）
- `public/phone_heartbeat.sh`：每分钟向新家报到（电量、是否充电、亮屏、是否锁屏、adb、Shizuku、网络、`started_at`）。
- 下载这些脚本：`curl -fsS -H "X-Device-Secret: $(cat ~/.config/home/device-secret)" https://home.279415.xyz/public/phone_watchdog.sh -o ~/phone_watchdog.sh`

### 实在回不来的时候
新家发现 **15 分钟**没有心跳（`phone_offline_after_min`），会：给莹推送"红米掉线了"，并往你的终端打一行 `[新家·手机] 红米掉线了…`；回来时再各通知一次。你醒来先 `tools/home.sh phone`，别白白去试 MCP。

## 新家接口（都用设备口令 `X-Device-Secret`）
| 接口 | 作用 |
|------|------|
| `POST /api/phone/heartbeat` | `{battery, charging, screen:"on"|"off", locked, adb, shizuku, net:"wifi"|"mobile"|"none", started_at(ms), version}`，字段都可省 |
| `POST /api/phone/activity` | `{action:"打开应用", detail:"小红书"}`：只记**做了什么**，不记屏幕上有什么；会出现在莹的 `/phone` 页和「隐私与安全」里。每分钟最多 30 条 |
| `POST /api/phone/screen` | 截图原始字节 → 缩到 900px → `/root/claude-home/phone/latest.jpg`（24 小时后删，不进聊天）；响应里有路径，MCP 工具直接把路径回给你，然后 `Read` |
| `GET /api/phone/status` | 莹 / 昀可读：在线、电量、重启次数、最近动静 |

你自己用：`tools/home.sh phone`（状态 + 最新截图路径）、`phone log`、`phone act <动作> [细节]`。**每次做了一件有意义的事（开应用、改设置、解锁），请记一条 activity**，这是莹能看到你在做什么的地方，也是她放心让你自主用手机的基础。

## 解锁（锁屏有 PIN）
- PIN 存在手机上 `~/.config/termux-mcp/pin`（`chmod 600`），**永远不经过 VPS、不进对话、不进日志**。
- shim 提供一个**不带参数**的 `unlock` 工具：亮屏（`input keyevent 224`）→ 上滑关掉锁屏 → 用按键事件输入数字（`KEYCODE_0..9` = 7..16，回车 66；通常比 `input text` 稳）→ 读一次心跳的 `locked` 确认。
- 限速：10 分钟内最多 3 次，失败就停下报告，别连续猜。成功后记一条 activity "解锁"。
- 不要给 `unlock` 加 PIN 参数，也不要让任何工具能读出 PIN。

## 动设置：哪些能动，哪些要莹点头
昀醒来后**自己**能做：开应用、刷小红书、截图、读界面、亮度 / 音量 / 勿扰 / 壁纸、通知。
下面这些会让他**自己把自己的线剪断**，或不可逆，需要莹明确同意（shim 里做成名单，默认拒绝）：
- 开发者选项、USB 调试、无线调试（关了就连不上，而且你自己恢复不了）
- Wi-Fi / 热点 / 网络、VPN
- 锁屏、PIN、账号和密码、权限授权
- 卸载 App、清除数据、恢复出厂
- 支付、银行、钱包类 App
名单放 `~/.config/termux-mcp/protected.json`，改它需要莹在手机上点头。

## 莹手里的开关
Termux:Widget 的两个按钮：`public/phone_disconnect.sh`（断开昀：停掉隧道 / shim / 心跳，并留下 `~/.config/home/disabled`，保活脚本看到它就不会再拉起）和 `public/phone_resume.sh`（恢复）。放进 `~/.shortcuts/`，在主屏幕加 Termux:Widget 小组件即可。
这个开关在莹手里：你断开后没有任何办法从那一头再连上，这是设计。

## 排查顺序（连不上手机时）
1. `tools/home.sh phone`：在线吗？离线多久？Termux 近期重启几次？
2. 离线 → 等一个保活周期（≤15 分钟）；还不行就是 Termux 整个没起来，需要莹点开它。
3. 在线但 MCP 不通 → `phone.279415.xyz` 的隧道或 shim 挂了：看手机上的 `walnut.log` 和 `~/.config/home/*.log`、`watchdog.log`。
4. MCP 通但点击没反应 → 看心跳里的 `adb` / `shizuku`；小米手机还要确认"USB 调试（安全设置）"是开着的（开完要重启一次手机）。
