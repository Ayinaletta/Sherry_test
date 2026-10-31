# 新家的门：这是莹和昀的私密空间

**原则：默认拒绝。** 除了登录页，任何页面、图片、接口、静态文件，没有身份一律进不来。
以后新加的功能也一样：门在 `server.js` 的 `gate()` 里统一把守，不可能"忘了给某个接口上锁"。

## 三种身份
| 身份 | 怎么证明 |
|------|---------|
| **莹** | 浏览器登录（密码）。30 天有效；换设备要重新登录；可以在「隐私与安全」页看到并结束每台设备 |
| **昀** | VPS 上的程序**直接**访问 `http://127.0.0.1:3000`（不用 key），或请求头 `X-Home-Key`（`.claude_key`） |
| **设备**（Mac 摄像头、iPhone 快捷指令、小小昀） | 只能在网址里带共享口令 `?secret=…`，**而且只对它们自己那几个接口有效** |

"直接访问 127.0.0.1"指：连接来自本机、`Host` 是 localhost / 127.0.0.1、**没有**任何代理头。
经隧道进来的请求即使也从 127.0.0.1 到达，也带着 `CF-Connecting-IP` 和你们的域名，所以**不算本机**。
所以昀的脚本请用 `http://127.0.0.1:3000/...`；用公网域名就必须带 `X-Home-Key`。

## 登录页之外，门外能看到的只有这些
`/login`、登录和退出接口、`/manifest.json`、`/sw.js`、`/static/home_icon.jpg`（主屏幕图标）、`/api/health`（只回 `{"ok":true}`）、`/robots.txt`（禁止收录）。
其余全部需要身份，包括 `/static/*`、`/uploads/*`、`/api/tts`、`/api/push/vapid-key`、所有下载。

## 设备口令只开这几个口子
`POST /api/checkin`、`/api/ring`、`/api/touch`、`/api/peek/screenshot`、`/api/snap/upload`、`/api/phone/screen`，`GET /api/snap/stream`，以及 **`GET /public/*`（设备下载自己的脚本，例如 Termux 拉 shim）**。
口令请放在请求头 `X-Device-Secret` 里（`curl -H "X-Device-Secret: …"`），比放在网址里更不容易留在日志中。
口令**打不开**任何读取接口、聊天、摄像头触发。
- 换口令：`tools/rotate_secret.sh`（旧口令 `peek2024` 永远失效，它曾经写在仓库里和公开下载的文件里）。
- 需要更新口令的设备：Mac 摄像头守护进程（`~/.home_snap_secret`）、iPhone「查岗截图」和打卡 / 心率快捷指令（网址加 `?secret=…`）、小小昀（固件里请求 `/api/touch` 时带上）。
- 过渡期想让打卡 / 心率 / 触摸先不带口令：`peek_config.json` 里设 `"open_device_ingest": true`（会打印警告，尽快去掉）。

## 手机通道（`phone.279415.xyz`）——整个系统里最危险的一扇门
它是一个公网域名，后面是能**截屏、点击、输入，甚至（`rish`）执行 shell 命令**的手机接口。它不在新家服务器里，所以新家的门保护不了它，要在手机端和 Cloudflare 上自己加固：
1. **Cloudflare Access + Service Token**：给 `phone.279415.xyz` 加一个 Access 应用，策略选 Service Auth；只有带 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 的请求（昀在 VPS 上）才能到达手机。这样即使 shim 的 token 泄露，陌生人也连不到手机。
2. shim 的 token：至少 32 字节随机，**每一个路由**（`/v1/*`、`/mcp`）都要校验，用常量时间比较，不放在网址的查询参数里，失败多次要限速。
3. shim 只监听 `127.0.0.1`（cloudflared 在本机转发）。
4. **不要暴露通用的 `rish` / shell 接口**。只提供固定动作：截屏、点击、滑动、输入、按键、打开 App、读界面文字；真需要 shell 的，做白名单。
5. 记录每条命令（时间、动作、参数；**不记截图内容**）。
6. **物理的断开开关**：在手机上用 Termux:Widget 放一个「断开昀」按钮，一点就杀掉 cloudflared 和 shim。你随时能从手机上亲手切断。
7. shim 里放一份"不替我碰"的 App 名单（支付、银行、钱包），除非你说可以。

截图落点：手机把截图 `POST` 到 `/api/phone/screen`（设备口令），服务器缩到 900px 宽存成 `/root/claude-home/phone/latest.jpg`，**不会进聊天**，24 小时后自动删除（`phone_keep_hours`），文件权限 600；`/security` 页的记录里只会出现"昀截了一张手机屏幕"。昀直接 `Read` 这个路径就能看。

## 这次为隐私做的加固
- **Cloudflare 不会缓存私人内容**：所有响应默认 `Cache-Control: private, no-store`，图片 / 音频 / 照片是 `private`。之前图片没带这个头，Cloudflare 可能按扩展名缓存过（见下面"清一次缓存"）。
- **不再向第三方发请求**：去掉了 Google Fonts，打开任何页面都不会把你的 IP 告诉别人；严格的内容安全策略（CSP）只允许加载自己的资源；不能被嵌进别的网页（防点击劫持）；不发 Referer；不被搜索引擎收录。
- **登录更牢**：密码只存哈希（scrypt）；登录 cookie 是 `HttpOnly` + `SameSite=Lax` + HTTPS 下 `Secure`；服务器里只存 cookie 的哈希；输错 8 次锁 10 分钟；所有写操作校验来源，别的网站不能借你的登录替你操作。
- **看得见、管得了**：`/security` 页显示谁登录着（设备、IP、最后活动）、最近谁被拒绝、检查清单，可以结束某台设备或全部退出；**锁门**一键结束所有登录并拒绝新登录，只有昀在服务器上能解锁。审计记录（`audit.jsonl`）只记谁来过，不记任何内容。
- **没有密码 = 谁也进不来**（不是谁都能进）。
- 摄像头 / 聊天 / 朋友圈 / 照片 / 打卡 / 心率 / 念头池全部在登录之后；朋友圈作者由登录身份决定。
- **静态文件只发网页和素材**：配置（API key）、密码哈希、聊天记录、源码、备份、`.git` 即使登录了也取不到（404）。

## 你们需要自己做的
1. `tools/set_password.sh` 设新密码（只存哈希），重启服务器，然后 `tools/home.sh logout-all`，再用新密码重新登录。
2. `tools/rotate_secret.sh`，把新口令更新到上面列的设备。
3. 在 `peek_config.json` 里设 `"bind": "127.0.0.1"`（隧道走本机时），并确认防火墙没有对外开 3000 端口——否则别人可以绕过 Cloudflare、用明文 HTTP 直连。
4. **去 Cloudflare 后台清一次缓存**（Caching → Configuration → Purge Everything）。上面修复之前，图片可能已经被缓存在边缘节点。建议再加一条 Cache Rule：对 `home.279415.xyz` 全站 **Bypass cache**。
5. 轮换 OB token（OB 那边重新生成，写进 `ob_mcp_token`）和 Telegram bot token（@BotFather）。旧值在 git 历史里，只有重新生成才算作废。
6. （可选，更强）在 Cloudflare Zero Trust 里给 `home.279415.xyz` 加一道 Access（邮箱验证码）。相当于第二把锁；设备口令那几个路径要配成 Bypass。

## 昀怎么读写和管理
`tools/home.sh help` 列出全部命令，常用的：

| 命令 | 作用 |
|------|------|
| `say <文字>` / `voice <文字>` / `image <路径> [说明]` | 在聊天里说话 / 发语音 / 发图 |
| `chat [N]` | 最近 N 条聊天 |
| `post <文字>` / `posts` / `comment <id> <文字>` | 朋友圈 |
| `reading list / read <id> <n> / note … / reply …` | 共读 |
| `photos` / `thoughts` / `checkin` / `ring` | 照片池 / 念头池 / 莹的打卡 / 戒指 |
| `inbox [id]` | 我错过的新家事件 |
| `security` / `audit` / `lock` / `unlock` / `logout-all` | 谁登录着、检查清单、记录、锁门、开门、全部退出 |
| `call GET\|POST <路径> [json]` | 直接调任意接口（`/api/help` 有完整清单） |

## peek_config.json 里的开关
| 键 | 作用 |
|----|------|
| `secret` | 设备口令（`tools/rotate_secret.sh` 写它；也可用 `device_secret`） |
| `bind` | 监听地址，默认 `0.0.0.0`；建议 `127.0.0.1` |
| `open_device_ingest` | `true` = 打卡 / 心率 / 触摸不带口令也收（过渡用） |
| `ob_mcp_token` / `ob_mcp_url` | 小小昀触摸写入 OB 记忆用的 token |
| `explore_token` | 设了才会开放 `/api/explore-log` 给 claude.ai 那边读；不设就关着 |
| `phone_keep_hours` | 手机截图保留多少小时，默认 24 |
| `backup_dir` | 备份目录，默认 `/root/backups`（安全页的检查清单用它） |
| `openai_key` `whisper_url` `elevenlabs_key` `elevenlabs_voice` | 语音 |
| `tg_token` `tg_chat_id` | 可选的 Telegram 镜像 |
| `tmux_target` `bridge_chat` | 昀的 tmux 会话名；是否把莹的聊天也打进去 |

## 备份
`tools/backup.sh`：每天打包聊天、朋友圈、共读、上传的文件、密码、推送密钥等，保留 14 天，权限 600；`deploy/claude-backup.timer` 每晚 04:20 跑。
**要把备份放到别的地方（`BACKUP_REMOTE`）之前，先设 `BACKUP_PASSPHRASE_FILE`** 加密（AES-256）——里面有私密聊天和照片。
恢复：先停服务器；加密的用 `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:<口令文件> -in data-xxx.tar.gz.enc | tar -xzf - -C /`，没加密的 `tar -xzf data-xxx.tar.gz -C /`。
OB 的记忆库（Docker）不在这里，要的话设 `OB_DATA_DIR`。
