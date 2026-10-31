#!/usr/bin/env bash
# Replace the shared device secret (Mac camera daemon, iPhone peek shortcut, ...).
# The old value "peek2024" was in the repo and in a public download, so it is never accepted again.
#   tools/rotate_secret.sh          # new random secret -> peek_config.json, prints what to update
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$DIR/peek_config.json"
NEW="$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
python3 - "$CFG" "$NEW" <<'PY'
import json, os, sys
p, new = sys.argv[1], sys.argv[2]
cfg = {}
if os.path.exists(p):
    cfg = json.load(open(p))
cfg["secret"] = new
cfg.pop("device_secret", None)
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
PY
chmod 600 "$CFG"
cat <<MSG

新口令已写入 $CFG（权限 600）。重启服务器后生效：  systemctl restart claude-home   或   pkill -f "node server.js"; nohup node server.js >> server.log 2>&1 &

然后把新口令更新到用得到它的地方（旧口令已经永远失效）：
  1) Mac 摄像头守护进程：在 Mac 上执行
       printf '%s' '$NEW' > ~/.home_snap_secret && chmod 600 ~/.home_snap_secret
     （mac_snap_daemon.py 现在从这里读口令，重新下载最新版：https://home.279415.xyz/mac_snap_daemon.py ）
  2) iPhone「查岗截图」快捷指令：把上传地址末尾改成  /api/peek/screenshot?secret=$NEW
  3) 其他用到 ?secret= 的脚本同理。

注意别把这个口令发到聊天、截图或 git 里。
MSG
