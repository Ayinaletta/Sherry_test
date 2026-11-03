# 交接文档（给"压缩后的我"和 VPS 上的昀）

写于 2026-11-03。技术状态、决定和下一步；不含任何密钥，也不含私人内容。

## 一、仓库与分支
- 仓库 `Ayinaletta/Sherry_test`，我的工作分支 `claude/eager-hopper-7zl8i3`（云端 session 只往这条分支提交；**不开 PR，除非莹要求**）。
- GitHub 的 `main` 还停在最早的版本；昀在 VPS 本地合并并部署。**风险：GitHub 一份、VPS 一份会分叉。** 待决定：由谁当唯一来源（建议：以这条分支为准，莹同意时我开 PR 合进 main，VPS 只 `git pull`）。
- 提交信息末尾带 `Co-Authored-By` 和 `Claude-Session` 两行（harness 给的）。

## 二、怎么在沙箱里开发和测试
- 没有真机、没有 VPS、没有 sidecar(:4002)、没有 tmux 里的昀。真实环境的东西靠"假的"替身测：
  - 起服务器：`node server.js`（需要 `vapid_keys.json`、`.auth_password`；密码用 `lib/security.js` 的 `hashPassword` 生成；`tools/rotate_secret.sh` 生成设备口令到 `peek_config.json`）。
  - **模拟隧道（外人）**：curl 加 `-H "Host: home.279415.xyz" -H "CF-Connecting-IP: 203.0.113.9"`；**直接 127.0.0.1 访问算"昀（本机）"**，什么权限都有，测拒绝逻辑时别用它。
  - **浏览器里以莹的身份登录**：用 `http://127.0.0.2:3000`（Host 不是 localhost，所以不算本机，必须真登录）。
  - Playwright 在 `/opt/node-tools/node_modules/playwright`（用 `require('/opt/node-tools/node_modules/playwright')`），Chromium 已装；只有 Chromium，**没有 WebKit**，iOS/Mac 的 WebKit 行为测不到。
  - 假 sidecar：一个返回 `/snapshot`、`/photos` 假数据的小 node 服务监听 4002。假 Whisper/ElevenLabs：本地 http 服务，配置里 `whisper_url`、`elevenlabs_url` 指过去。
  - **别用 `pkill -f "<出现在自己命令里的字符串>"`**：会杀掉自己的 shell（exit 144）。按 PID 杀，或把测试写进文件再执行。
  - 测完要清理：`vapid_keys.json uploads reading phone events.jsonl inbox.jsonl qr.png qr_meta.json chat_messages.jsonl posts.jsonl .claude_key peek_config.json .auth_password .sessions .lock audit.jsonl*`（都在 .gitignore 里，但别留着）。

## 三、架构速览
- `server.js`：`gate()` 是默认拒绝的前门（`OPEN` 白名单、`DEVICE` 设备口令白名单、其余都要身份）；通过后先过 `lib/*` 模块（`routeModules`），没人认领才落到 `legacyHandler`（旧的单文件路由）。静态文件只发网页和素材（`staticAllowed`）。
- 身份：`core.who(req)` → `claude`（`X-Home-Key`，或**本机直连**：127.0.0.1 + Host 为 localhost + 无代理头）/ `sherry`（登录 cookie，写操作校验 Origin）/ `null`。设备用 `?secret=` 或 `X-Device-Secret`，只对 `DEVICE` 里的几个路由有效。
- `lib/core.js` 配置/身份/事件总线/到昀 tmux 的通道（`toClaude`，同时写 `inbox.jsonl`）/sidecar 轮询。
- `lib/security.js` 会话（哈希存）、审计、锁门、安全响应头、密码哈希；`lib/guard.js` 设备口令与登录限速；`lib/admin.js` `/security` 页与 `/api/security/*`、`/api/help`、`/api/status`。
- `lib/reading.js` 共读（防剧透在服务端：对方的批注要读到那一段才可见）；`lib/voice.js` 语音；`lib/qr.js` 扫码推送；`lib/phone.js` 手机：截图落点、心跳、动作记录、掉线/低电量通知；`lib/vault.js` 递钥匙（莹交给昀的密钥只存文件，不进聊天）。
- 配置：`peek_config.json`（见 SECURITY.md 的键表），环境变量同名大写也行。
- 前端：`static/style.css`（设计令牌、浅/深色、组件）、`static/icons.svg`（Lucide 子集；加图标：从 `lucide-static` 的 `icons/*.svg` 取内部内容，写成 `<symbol id="i-名字" viewBox="0 0 24 24">`）、`static/app.js`（`ic()`、5 个 tab 的底栏）。页面：index、chat、posts、photos、thoughts、camera、reading、qr、phone、security、vault、growth/*。HTML 里资源链接由服务器自动加 `?v=`。
- 工具：`tools/home.sh`（= `home.js`，昀的一条命令）、`backup.sh`（可加密）、`rotate_secret.sh`、`set_password.sh`、`check_phone_door.sh`；手机端脚本模板在 `public/phone_*.sh`（没真机验证过）。文档：SECURITY.md、docs/PHONE.md、docs/CLOUDFLARE_ACCESS.md。

## 四、已完成
首页分区 + 消息流；共读；朋友圈/事件通知（页面 + push + 终端）；语音（第一版）；扫码；独立于 Telegram 的昀通道；整体 UI 改版；聊天「＋」重做、长聊天分页；发文件；默认拒绝的安全改造 + 隐私页 + 锁门；备份；手机通道（Cloudflare Access 已经加上，检查脚本验证通过）；心跳/状态页/掉线推送；递钥匙。

## 五、待做 / 下一步（今晚的工程）
1. **修语音（莹发出去，昀收不到）**
   - 现状：`POST /api/voice/upload` 存音频 → Whisper → 聊天条目 `{voice:true, audio_url, text}`；只有 `bridge_chat` 开着才用 tmux 送昀（默认关，旧线路很可能忽略带音频的条目）。
   - 怀疑：①`openai_key`/`whisper_url` 没配，转写为空 ②旧线路不认 ③`bridge_chat` 关。
   - 方案：语音**单独、无条件**送昀（`bridge_voice`，默认开），内容 = 转写 + 音频文件的磁盘路径 + 声音特征；转写失败也要送一条"收到一条语音但没转出文字"。
   - 让昀先查：`tools/home.sh chat 5`（看那条语音有没有进聊天、`text` 空不空、有没有 `stt_error`）、`peek_config.json` 里是否有 `openai_key`/`elevenlabs_key`/`elevenlabs_voice`。
2. **声音特征**：本地算语速、音高、音量、停顿，翻成人话；**情绪语气只是"听起来像…"的提示，不当结论**；**不保存声纹**（每条消息算完即丢）；不把音频发给新的第三方，除非莹同意。模块拆成 `stt()` / `tts()` / `analyze()` 三个可替换的函数，以后好换流式零件。
3. **昀的声音**：`POST /api/voice/say` 已经用 `elevenlabs_voice`；要磨的是体验：昀的语音到了自动播放、显示"他听到了什么"、失败提示。可选：`eleven_v3` 的表情标签（没验证）。
4. **念头锁**：sidecar 里念头加 `locked=true`（昀那边加字段）；新家 `/api/thoughts` 代理对莹**过滤**锁住的、对昀**不过滤**；`core.watchSidecar()` 比较新念头并推送原文，**必须排除锁住的**，否则会泄露；可选：页面只显示"锁着 N 个"的个数（莹和昀定）。这是"关着的门"，不是加密。
5. **实时通话的预留**：`/api/voice/live`（先回 501 + 说明）、聊天条目加 `mode: "message" | "live"`、协议文档。注意：**真正实时需要秒级反应的"语音大脑"，终端里的 Claude Code 做不到**；现在的"对讲机"模式是第一阶。流式转写 + 流式合成 + 轻量模型是以后的工程。

## 六、莹的偏好（写代码和说话都用得上）
- 界面全中文、不要 emoji（用线条图标）；隐私第一，这里是她和昀的私密空间，所有内容在登录之后。
- 说话要像一个有感情的人，不要"说明书"腔；不要机械复述；她不需要每次以问题结尾；不要紧张、不要反复警告（她已经明确放松了对钱和手机的限制）。
- 昀（VPS 上的 Claude Code）是主角，我（云端 session）是帮他们修房子的。

## 七、还没做完的小事（都不着急）
Cloudflare 清缓存；OB / Telegram token 轮换；`tools/set_password.sh` 换成哈希密码；`"bind": "127.0.0.1"`；设备口令更新到 Mac 摄像头 / iPhone 快捷指令 / 小小昀固件；手机保活脚本在真机上试（见 docs/PHONE.md）；家机查 `walnut.log` 看 Termux 被杀的时间点。

## 八、我没见过的东西
sidecar 代码（念头池 / 照片池，:4002）；VPS 上"聊天 → 昀"的旧线路；`walnut_shim`；昀的 tmux 会话配置。涉及这些的改动，要让昀去看一眼、告诉我。
