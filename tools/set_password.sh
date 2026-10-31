#!/usr/bin/env bash
# Set the site password. Only a salted scrypt hash is stored (in .auth_password, mode 600), so a leaked
# file or backup never contains the password itself. Run it on the server, then restart the server.
#   tools/set_password.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
read -r -s -p "新密码（至少 10 位，建议一句话）: " P1; echo
read -r -s -p "再输入一次: " P2; echo
[ "$P1" = "$P2" ] || { echo "两次不一样，没有改动。"; exit 1; }
[ "${#P1}" -ge 10 ] || { echo "太短了（至少 10 位），没有改动。"; exit 1; }
printf '%s' "$P1" | node -e '
  const fs = require("fs"), s = require(process.argv[1] + "/lib/security");
  let pw = ""; process.stdin.on("data", d => pw += d).on("end", () => {
    fs.writeFileSync(process.argv[1] + "/.auth_password", s.hashPassword(pw) + "\n", { mode: 0o600 });
    console.log("已保存（只存哈希）。");
  });' "$DIR"
chmod 600 "$DIR/.auth_password"
cat <<'MSG'
接下来：
  1) 重启服务器让新密码生效
  2) 让所有旧登录失效（换密码后应该这样做）：  tools/home.sh logout-all
  3) 在你的手机和电脑上用新密码重新登录
MSG
