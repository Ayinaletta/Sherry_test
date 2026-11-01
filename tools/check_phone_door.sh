#!/usr/bin/env bash
# Is Cloudflare Access really standing in front of the phone?  (run on the VPS)
#   tools/check_phone_door.sh [https://phone.279415.xyz/mcp]
# Reads the service token from ~/.config/phone/cf-access (line 1 = Client ID, line 2 = Client Secret)
# or from CF_ACCESS_ID / CF_ACCESS_SECRET.
set -u
URL="${1:-https://phone.279415.xyz/mcp}"
F="$HOME/.config/phone/cf-access"
ID="${CF_ACCESS_ID:-$(sed -n 1p "$F" 2>/dev/null)}"; SECRET="${CF_ACCESS_SECRET:-$(sed -n 2p "$F" 2>/dev/null)}"
say() { printf '%s\n' "$*"; }

say "1) 不带令牌去敲门（陌生人的样子）..."
R="$(curl -s -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' "$URL")"; CODE="${R%% *}"; REDIR="${R#* }"
if [[ "$REDIR" == *cloudflareaccess.com* ]] || [ "$CODE" = "403" ]; then
  say "   门锁着：Cloudflare 把陌生人挡在外面了（$CODE）。"; LOCKED=1
elif [ "$CODE" = "000" ]; then
  say "   连不上（$URL）。手机和隧道在线吗？这一步无法判断。"; exit 2
else
  say "   【危险】陌生人直接到了手机的程序（HTTP $CODE）。Access 还没有挡在前面，或者策略没生效。"; LOCKED=0
fi

say "2) 带令牌去敲门（昀的样子）..."
if [ -z "$ID" ] || [ -z "$SECRET" ]; then say "   没找到令牌（$F 或环境变量），跳过。"; [ "${LOCKED:-0}" = 1 ] && exit 0 || exit 1; fi
R2="$(curl -s -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" "$URL")"; C2="${R2%% *}"; D2="${R2#* }"
if [[ "$D2" == *cloudflareaccess.com* ]] || [ "$C2" = "403" ]; then
  say "   令牌被拒绝（$C2）：Client ID / Secret 抄错了，或策略里没有选这个令牌，或令牌过期。昀现在进不去！"; exit 1
elif [ "$C2" = "000" ]; then say "   连不上。"; exit 2
else
  if [ "${LOCKED:-0}" = 1 ]; then say "   令牌有效：Cloudflare 放行了，请求到了手机的程序（它自己的回应是 HTTP $C2；401 表示还需要 shim 自己的 token，这是正常的）。"
  else say "   请求到了手机的程序（HTTP $C2），但这不是令牌的功劳：根本没有 Access 在前面。"; fi
fi
[ "${LOCKED:-0}" = 1 ] && say "结论：双层锁都在 ✔" || { say "结论：令牌能用，但门没有锁 ✘"; exit 1; }
