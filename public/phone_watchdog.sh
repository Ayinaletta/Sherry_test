#!/data/data/com.termux/files/usr/bin/bash
# phone_watchdog.sh - brings the phone's stack back if Android killed it in the background.
#
# Android (12 especially) and MIUI quietly kill Termux's child processes. Termux:Boot only helps at boot, so this
# is run again every ~15 minutes by Android's own job scheduler, which survives Termux being killed:
#
#   termux-job-scheduler --job-id 77 --script "$HOME/phone_watchdog.sh" --period-ms 900000 --persisted true --network any
#
# and once from ~/.termux/boot/ at boot. Edit the three START_* lines to however you really start each piece.
# !! A template, written without the real phone: test it by hand (kill cloudflared, run it, watch it come back).
set -u
LOG="$HOME/.config/home/watchdog.log"; mkdir -p "$(dirname "$LOG")"
# 莹's off switch (phone_disconnect.sh) leaves this file: while it exists, nothing is restarted.
[ -e "$HOME/.config/home/disabled" ] && exit 0
START_TUNNEL=${START_TUNNEL:-'cloudflared tunnel run'}                      # whatever starts phone.279415.xyz's tunnel
START_SHIM=${START_SHIM:-'python3 $HOME/walnut_shim.py'}                    # the MCP / bridge on :8766
START_HEARTBEAT=${START_HEARTBEAT:-'bash $HOME/phone_heartbeat.sh'}

ensure() {   # name  pattern  command
  if pgrep -f "$2" >/dev/null 2>&1; then return; fi
  echo "$(date '+%F %T') $1 was not running; starting it" >> "$LOG"
  nohup setsid bash -c "$3" >> "$HOME/.config/home/$1.log" 2>&1 &
}
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
ensure tunnel    'cloudflared'          "$START_TUNNEL"
ensure shim      'walnut_shim'          "$START_SHIM"
ensure heartbeat 'phone_heartbeat.sh'   "$START_HEARTBEAT"
tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
