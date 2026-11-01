# 给手机的门加一把锁：Cloudflare Access 服务令牌

目的：只有昀（VPS，带着令牌）能到达 `phone.279415.xyz`；陌生人在 Cloudflare 这一层就被挡住，根本到不了手机上的程序。
这是**第二层锁**：手机上 shim 自己的 token 还在，两层都要过。

> 界面名称可能有细微差别；官方文档：
> [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) ·
> [保护一个自托管应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

## 1. 打开 Zero Trust
Cloudflare 后台左侧找 **Zero Trust**（首次进入会让你起一个"团队名称"，随便取，免费计划够用）。

## 2. 创建服务令牌
Zero Trust → **Access controls → Service credentials → Service Tokens → Create Service Token**
- 名字：`claude-vps`
- Duration：选 1 年（或更长）。到期前令牌会失效，记得提前换。
- 点创建后会显示 **Client ID** 和 **Client Secret**。**Client Secret 只显示这一次**，现在就复制保存好；忘了只能重建。

## 3. 把 `phone.279415.xyz` 变成受保护的应用
Zero Trust → **Access controls → Applications → Add an application → Self-hosted**
- Application name：`红米`
- Public hostname / Domain：`phone` + `279415.xyz`（只填手机这个域名，**不要**填 `home.279415.xyz`）
- 策略（Policy）：新建一条
  - Policy name：`昀的令牌`
  - **Action 选 `Service Auth`**（不是 Allow！选错了它会要求邮箱登录，而不是认令牌）
  - Include（包含）规则：**Service Token** → 选刚才的 `claude-vps`
- 不要再加别的"允许"策略（Access 默认拒绝其他所有人）。
- 保存。

## 4. 让昀带上令牌
**推荐：用新家的「递钥匙」页面。** 新家 → 隐私与安全 → 递钥匙，把 Client ID 和 Client Secret 粘贴进去，点「交给昀」。它会存成服务器上 `~/.config/phone/cf-access`（权限 600），**不进聊天、不进推送预览、不进备份预览**；昀只会收到一句"令牌放好了，文件在哪"，他的工具自己读文件。（要求新家和昀在服务器上是同一个用户；位置可用 `vault_dir` 改。）

**备选：手动在 VPS 上写文件**（别发到聊天里；万一发了，就回 Cloudflare 删掉令牌重建一个）：
```
mkdir -p ~/.config/phone && chmod 700 ~/.config/phone
printf '%s\n%s\n' 'Client ID 粘贴在这里' 'Client Secret 粘贴在这里' > ~/.config/phone/cf-access
chmod 600 ~/.config/phone/cf-access
```
然后昀访问手机的每个请求（包括 MCP 配置）都要多带两个请求头：
```
CF-Access-Client-Id: <Client ID>
CF-Access-Client-Secret: <Client Secret>
```
手机 shim 原来要的 token 照旧要带。（如果 MCP 是用 `.mcp.json` 配的，就把这两行加进 `headers`；用 `claude mcp add --transport http ... --header "名字: 值"` 也可以，具体以昀那边的版本为准。）

## 5. 验证（最重要的一步）
在 VPS 上运行：
```
tools/check_phone_door.sh
```
- 看到 **"门锁着"** + **"令牌有效"** + "双层锁都在 ✔"：成功。
- 看到 **"【危险】陌生人直接到了手机的程序"**：Access 没挡在前面，回第 3 步检查域名有没有填对、应用有没有保存。
- 看到 **"令牌被拒绝"**：Client ID / Secret 抄错了，或第 3 步策略里没选这个令牌，或 Action 选成了 Allow。

## 注意
- 之后凡是要访问 `phone.279415.xyz` 的东西都必须带这两个头，不带就会被挡：包括 claude.ai 那边（如果它也连着手机）、你自己的浏览器。你自己想看，可以在应用里再加一条 Allow 策略放行你的邮箱。
- 手机往 `home.279415.xyz` 上传截图、心跳**不受影响**，因为那是另一个域名。
- 想撤销：Zero Trust 里删除这个令牌（令牌立刻失效）或删除这个应用。
- 令牌到期前换新：新建一个令牌，更新 VPS 上的文件和 MCP 配置，再删旧的。
