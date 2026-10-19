#!/usr/bin/env bash
# Claude's hands inside the house. Talks to the local server with the key in .claude_key.
#   tools/home.sh GET  /api/reading
#   tools/home.sh POST /api/reading/<doc>/annotations '{"unit":3,"quote":"...","note":"..."}'
#   tools/home.sh voice "想说给莹听的话"
#   tools/home.sh qr /path/to/qr.png "淘宝"
#   tools/home.sh inbox [since_id]
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${HOME_URL:-http://127.0.0.1:3000}"
KEY="$(cat "$DIR/.claude_key")"
H=(-H "X-Home-Key: $KEY")
case "${1:-}" in
  voice) curl -sS "${H[@]}" -H 'Content-Type: application/json' -X POST "$BASE/api/voice/say" \
           --data "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$2")" ;;
  qr)    curl -sS "${H[@]}" -H 'Content-Type: image/png' -X POST --data-binary "@$2" \
           "$BASE/api/qr/push?label=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "${3:-二维码}")&ttl=${4:-180}" ;;
  inbox) curl -sS "${H[@]}" "$BASE/api/inbox?since=${2:-0}" ;;
  GET|DELETE) curl -sS "${H[@]}" -X "$1" "$BASE$2" ;;
  POST)  curl -sS "${H[@]}" -H 'Content-Type: application/json' -X POST "$BASE$2" --data "${3:-{\}}" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
echo
