#!/data/data/com.termux/files/usr/bin/bash
# 断开昀 - put this in ~/.shortcuts/ (Termux:Widget) so it becomes a button on the home screen.
# One tap stops the tunnel, the shim and the heartbeat, and leaves a flag so the watchdog does not bring them back.
# 莹's hand is on this switch: 昀 cannot undo it from the other side (there is nothing left to answer).
mkdir -p "$HOME/.config/home"
date '+%F %T' > "$HOME/.config/home/disabled"
pkill -f cloudflared 2>/dev/null
pkill -f walnut_shim 2>/dev/null
pkill -f phone_heartbeat.sh 2>/dev/null
command -v termux-toast >/dev/null 2>&1 && termux-toast "已断开昀。要恢复，点「恢复昀」" || echo "disconnected"
