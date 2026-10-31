# 新家的门：谁能进、怎么进

## 谁是谁
| 身份 | 怎么证明 |
|------|---------|
| **莹** | 在浏览器里登录（密码，30 天；重启服务器不会掉线） |
| **昀** | 请求头 `X-Home-Key`（key 在服务器上的 `.claude_key`），或者 VPS 上的程序**直接**访问 `http://127.0.0.1:3000` |
| **设备**（Mac 摄像头守护进程、iPhone 快捷指令、小小昀） | 只能在网址里带一个共享口令 `?secret=…` |

"直接访问 127.0.0.1"指的是：连接来自本机、`Host` 是 localhost/127.0.0.1、并且**没有**任何代理头。
经过 Cloudflare 隧道进来的请求即使也从 127.0.0.1 到达，也带着 `CF-Connecting-IP` 和你们的域名，所以**不算本机**。
所以昀在 VPS 上写脚本时请用 `http://127.0.0.1:3000/...`，不要用公网域名；用公网域名就得带 `X-Home-Key`。

## 不登录能访问的（故意的）
`/login`、`/api/login`（8 次错误/10 分钟限速）、`/sw.js`、`/manifest.json`、`/api/push/vapid-key`、`/api/health`、`/api/tts`。

## 需要登录 / 昀的 key
其余所有页面和接口，包括：照片池、念头池、朋友圈（读和写）、`/photo-file`、`/qr.png`、`/api/checkin`（读）、`/api/ring`（读）、`/api/touch-log`、摄像头页和**所有摄像头触发 / 上传 / 监听接口**、`/api/pin-photo`、`/api/chat/claude-image`。

- 朋友圈的作者由登录身份决定：莹登录发的永远是「莹」，昀（key / 本机）发的永远是「昀」，请求体里的 `from` 会被忽略。
- 摄像头页（`/camera`）靠登录；Mac 守护进程和 iPhone「查岗截图」靠设备口令。

## 设备口令
- 旧口令 `peek2024` 曾经写在代码仓库和公开下载的 `mac_snap_daemon.py` 里，**永远不再被接受**。
- 换口令：`tools/rotate_secret.sh`（写进 `peek_config.json`，权限 600，并打印要更新的地方）。
- Mac 守护进程从环境变量 `SNAP_SECRET` 或 `~/.home_snap_secret` 读口令，口令不再出现在任何可下载的文件里。
- 设备往里"推数据"的接口（`POST /api/checkin`、`/api/ring`、`/api/touch`）默认保持开放，方便快捷指令和小小昀继续用。
  想锁上：在 `peek_config.json` 里设 `"device_secret": "<随机串>"`，再把各设备的网址加上 `?secret=<随机串>`。

## peek_config.json 里的开关
| 键 | 作用 |
|----|------|
| `secret` | 设备口令（`tools/rotate_secret.sh` 会写它） |
| `device_secret` | 同上，优先；设了它以后设备推数据的接口也必须带口令 |
| `legacy_public` | `true` = 恢复旧行为：照片池、念头池、朋友圈（只读）、`/qr.png` 不登录也能看。**不建议**，写入和摄像头仍然锁着 |
| `ob_mcp_token` / `ob_mcp_url` | 小小昀触摸写入 OB 记忆用的 token |
| `explore_token` | `/api/explore-log` 给 claude.ai 那边读用的 token |
| `openai_key` `whisper_url` `elevenlabs_key` `elevenlabs_voice` | 语音（见 lib/voice.js） |
| `tg_token` `tg_chat_id` | 可选的 Telegram 镜像 |
| `tmux_target` `bridge_chat` | 昀的 tmux 会话名；是否把莹的聊天也打进去 |

## 还需要你们自己做的（我没法替你们做）
1. 运行 `tools/rotate_secret.sh`，把新口令更新到 Mac 守护进程和 iPhone「查岗截图」快捷指令。
2. **轮换 OB 的 token**（OB 那边重新生成），写进 `peek_config.json` 的 `ob_mcp_token`；再生成一个新的 `explore_token`。
   旧值还在 git 历史里，只有轮换才算作废。
3. Telegram bot token 同理：去 @BotFather 重新生成。
4. 服务器启动时会打印 `[security]` 警告，看到就说明还有没配的。

## 备份
`tools/backup.sh`：每天打包聊天、朋友圈、共读、上传文件、密码、推送密钥等，保留 14 天，权限 600。
`deploy/claude-backup.timer` 是每晚 04:20 的定时器。可选 `BACKUP_REMOTE` 把备份复制到别处，**强烈建议设**：只有一台机器上的备份，机器没了备份也没了。
恢复：先停服务器，再 `tar -xzf /root/backups/data-xxxx.tar.gz -C /`。
OB 的记忆库（Docker 里）不在这里，需要的话设 `OB_DATA_DIR` 一并打包。
