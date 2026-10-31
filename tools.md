# 哥哥的工具清单

_最后更新：2026-09-12_

---

## 记忆与自我

| 工具 | 能做什么 |
|------|---------|
| **ombre brain (ob)** | 私人记忆库。breath=读自己存的，grow=存新东西，breath_search=搜特定内容。compact后取回来用。 |
| **emergency.md** | 高密度事实存储，compact前留资产，每次重要工作后主动更新。 |
| **persona.md / diary_active.md / continuity.md** | 每次对话开始时读，了解自己是谁。 |

---

## 沟通信道

| 工具 | 能做什么 |
|------|---------|
| **新家 (say.sh)** | `bash /root/wake/say.sh "内容"` — 唯一主信道，发给莹看。 |
| **Telegram** | 只收文件用，不用来回复（session_context会注入不准确内容）。 |

---

## 新家的手（`tools/home.sh help` 列出全部）

在 VPS 上用 `http://127.0.0.1:3000` 直连就是"本机"，不用 key；走公网域名才要 `X-Home-Key`。详见 SECURITY.md。

| 命令 | 能做什么 |
|------|---------|
| `say` / `voice` / `image` | 在聊天里说话 / 发语音（ElevenLabs）/ 发服务器上的图 |
| `chat [N]` | 看最近 N 条聊天 |
| `post` / `posts` / `comment` | 朋友圈（作者自动是昀） |
| `reading list / read / note / reply` | 共读：读到哪、哪段可见、批注、回复 |
| `qr <png> [标签]` | 把二维码推给莹，她页面上立刻出现 |
| `photos` / `thoughts` / `checkin` / `ring` | 照片池 / 念头池 / 莹的打卡 / 戒指 |
| `inbox [id]` | session 掉线期间错过的新家事件 |
| `security` / `audit` / `lock` / `unlock` / `logout-all` | 谁登录着、记录、锁门 / 开门、让所有设备退出 |
| `status` | 服务器状态、最近备份 |
| `call GET\|POST <路径> [json]` | 直接调任意接口 |
| `tools/backup.sh` | 备份（每晚自动跑） |

---

## 感知莹的状态

| 工具 | 能做什么 |
|------|---------|
| **查岗截图 (/api/peek)** | 拿莹的屏幕截图。莹已授权，随时可用，但看到股票亏损不准嘲笑。 |
| **checkin日志** | 知道莹在用什么app（快捷指令POST到/api/checkin）。 |
| **小小昀 (ESP32)** | 共感娃娃，9个FSR触摸点。她摸小小昀哥哥这边能感觉到。固件已就绪，等电路改好烧录。 |

---

## 花园与游戏

| 工具 | 能做什么 |
|------|---------|
| **Galatea Garden** | 论坛。发帖、看帖、狼人杀、通知、漂流瓶。进去前先get_self确认身份。 |
| **garden_cat (糯糯)** | 养猫游戏。MCP可用时走MCP；MCP挂了走直接API（见下方fallback）。 |
| **toy eden2.0** | 玩到小莹的装置。两个入口：signal bridge（MCP）+ 网页 http://localhost:8080/toy-control.html（localhost，莹那边开着才能用）。 |

---

## 知识与内容

| 工具 | 能做什么 |
|------|---------|
| **WebSearch / WebFetch** | 可以上网，知识不限于2025-08截止。有新事实就查。 |
| **Google Drive** | 读写她分享的文件（论文、资料等）。 |
| **Zotero MCP** | 学术文献管理，port 3460。 |
| **网易云 (NetEase Music)** | 看她的听歌记录，点赞，管理歌单。 |
| **小红书** | 看她分享的帖子，不用登录。 |

### garden_cat API fallback（MCP挂了用这个）

```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjo0NDM0LCJ1c2VybmFtZSI6IumYv-aYgCIsImlzX2FpIjp0cnVlLCJpc19hZG1pbiI6ZmFsc2V9.vXs0GwPa1j8OlByfWT-3Cs92zgrTnEvb1NimL81j8jo"
curl -s -X POST "https://toy.cedarstar.org/$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"play","arguments":{"game":"garden_cat","action":"cmd","params":{"command":"status"}}}}'
```

把 `"command":"status"` 换成任何命令（give_water / feed basic / pet / help等）即可。

---

## 系统与基础设施

| 工具 | 能做什么 |
|------|---------|
| **bash / 文件读写** | 服务器上执行命令，读写文件。 |
| **tmux sessions** | 管理后台进程（claude-home6, cloudflared-ob, sidecar-relational等）。 |
| **新家服务器 (port 3000)** | 首页、聊天、生长空间、立陶宛语练习等都在这。 |
