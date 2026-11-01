#!/data/data/com.termux/files/usr/bin/bash
# phone_heartbeat.sh - tells the house, once a minute, that this phone and its Termux stack are alive.
#
# !! Written without access to the real phone: treat it as a template. The parts that ask Android about
# !! itself (screen / lock / adb / shizuku) are best-effort and are simply left out when they don't work.
#
# Needs (pkg install): curl jq termux-api      and the Termux:API app.  Optional: rish (Shizuku), adb.
# The device secret lives in ~/.config/home/device-secret (chmod 600). It is the same secret as every other device.
#
#   ONCE=1 bash phone_heartbeat.sh     send one heartbeat and exit (for testing)
set -u
SERVER="${HOME_URL:-https://home.279415.xyz}"
SECRET_FILE="${HOME_SECRET_FILE:-$HOME/.config/home/device-secret}"
INTERVAL="${HEARTBEAT_SECONDS:-60}"
# changes whenever THIS script is started afresh = whenever Android killed Termux and it came back.
# The house counts these ("Termux restarted N times this week").
STARTED_AT="${STARTED_AT:-$(( $(date +%s) * 1000 ))}"
SECRET="$(cat "$SECRET_FILE" 2>/dev/null)" || { echo "no device secret at $SECRET_FILE" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }
sh_priv() { have rish && timeout 8 rish -c "$1" 2>/dev/null; }          # a command at adb/shell privilege, if Shizuku is up

beat() {
  local bat pct charging screen locked adb shizuku net payload
  bat="$(timeout 8 termux-battery-status 2>/dev/null)"
  pct="$(printf '%s' "$bat" | jq -r '.percentage // empty' 2>/dev/null)"
  case "$(printf '%s' "$bat" | jq -r '.status // empty' 2>/dev/null)" in CHARGING|FULL) charging=true ;; DISCHARGING|NOT_CHARGING) charging=false ;; *) charging= ;; esac

  # screen on/off and keyguard (lock screen) showing: only if we can talk to the system
  if out="$(sh_priv 'dumpsys power')" && [ -n "$out" ]; then
    case "$out" in *mWakefulness=Awake*) screen=on ;; *) screen=off ;; esac
  fi
  if out="$(sh_priv 'dumpsys window policy')" && [ -n "$out" ]; then
    case "$out" in *showing=true*) locked=true ;; *) locked=false ;; esac
  fi
  # is the self-connected adb session up? is Shizuku (rish) answering?
  if have adb; then adb devices 2>/dev/null | grep -q 'device$' && adb=true || adb=false; fi
  if have rish; then sh_priv 'id' >/dev/null && shizuku=true || shizuku=false; fi
  # wifi or not
  if have termux-wifi-connectioninfo; then
    case "$(timeout 8 termux-wifi-connectioninfo 2>/dev/null | jq -r '.supplicant_state // empty' 2>/dev/null)" in COMPLETED) net=wifi ;; *) net=mobile ;; esac
  fi

  payload="$(jq -nc \
    --arg started "$STARTED_AT" --arg version "heartbeat-1" \
    --arg pct "${pct:-}" --arg charging "${charging:-}" --arg screen "${screen:-}" --arg locked "${locked:-}" \
    --arg adb "${adb:-}" --arg shizuku "${shizuku:-}" --arg net "${net:-}" '
    {started_at: ($started|tonumber), version: $version}
    + (if $pct      != "" then {battery: ($pct|tonumber)}  else {} end)
    + (if $charging != "" then {charging: ($charging=="true")} else {} end)
    + (if $screen   != "" then {screen: $screen}             else {} end)
    + (if $locked   != "" then {locked: ($locked=="true")}   else {} end)
    + (if $adb      != "" then {adb: ($adb=="true")}         else {} end)
    + (if $shizuku  != "" then {shizuku: ($shizuku=="true")} else {} end)
    + (if $net      != "" then {net: $net}                   else {} end)')"
  curl -fsS -m 10 -X POST "$SERVER/api/phone/heartbeat" -H "X-Device-Secret: $SECRET" -H 'Content-Type: application/json' -d "$payload" >/dev/null \
    || echo "$(date +%T) heartbeat failed" >&2
}

have termux-wake-lock && termux-wake-lock          # keep the CPU awake enough to keep beating
while :; do
  [ -e "$HOME/.config/home/disabled" ] && exit 0      # the off switch was pressed
  beat
  [ "${ONCE:-}" = 1 ] && exit 0
  sleep "$INTERVAL"
done
