#!/data/data/com.termux/files/usr/bin/bash
# 恢复昀 - the other Termux:Widget button. Removes the flag and starts everything again (the watchdog does the starting).
rm -f "$HOME/.config/home/disabled"
bash "$HOME/phone_watchdog.sh"
command -v termux-toast >/dev/null 2>&1 && termux-toast "昀回来了" || echo "resumed"
