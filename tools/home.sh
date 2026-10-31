#!/usr/bin/env bash
# 昀's hands inside the house. Run `tools/home.sh help` for everything it can do.
exec node "$(cd "$(dirname "$0")" && pwd)/home.js" "$@"
