#!/usr/bin/env bash
# Daily backup of everything that lives only on this server (none of it is in git).
#   tools/backup.sh              make a backup now
#   tools/backup.sh list         show existing backups
#   tools/backup.sh verify       test-read the newest archive
# Restore (stop the server first):  tar -xzf /root/backups/data-YYYYmmdd-HHMMSS.tar.gz -C /
#
# Environment (all optional):
#   BACKUP_DIR      where archives go                     (default /root/backups, mode 700)
#   KEEP_DAYS       delete archives older than this       (default 14)
#   BACKUP_PHOTOS   1 = also archive /root/sherry (can be big)   (default 0)
#   OB_DATA_DIR     path of the OB memory data, if you want it included
#   BACKUP_PASSPHRASE_FILE  file holding a passphrase: the archive is encrypted (AES-256) -> data-*.tar.gz.enc.
#                   STRONGLY recommended before BACKUP_REMOTE: the archive holds private photos and chats.
#                   Restore: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:<file> -in data-X.tar.gz.enc | tar -xzf - -C /
#   BACKUP_REMOTE   also copy the new archive off this machine:
#                     rclone:<remote>:<path>   (needs rclone configured)   or   user@host:/path   (rsync over ssh)
# The archive holds passwords, push keys and private photos: it is written 0600. Keep copies somewhere private.
set -euo pipefail
HOME_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
log() { echo "[backup $(date +%H:%M:%S)] $*"; }

umask 077
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"

case "${1:-run}" in
  list)   ls -lh "$BACKUP_DIR" | sed 1d; exit 0 ;;
  verify) f="$(ls -1t "$BACKUP_DIR"/data-*.tar.gz* 2>/dev/null | head -1)"; [ -n "$f" ] || { echo "no backups"; exit 1; }
          if [[ "$f" == *.enc ]]; then
            [ -n "${BACKUP_PASSPHRASE_FILE:-}" ] || { echo "$f is encrypted: set BACKUP_PASSPHRASE_FILE to verify"; exit 1; }
            n=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:"$BACKUP_PASSPHRASE_FILE" -in "$f" | tar -tz | wc -l)
          else n=$(tar -tzf "$f" | wc -l); fi
          [ "$n" -gt 0 ] && echo "OK  $f  ($n entries)"; exit 0 ;;
  run)    ;;
  *)      sed -n '2,6p' "$0"; exit 1 ;;
esac

# what to save (only what exists); paths are stored relative to / so a restore puts them back in place
CANDIDATES=(
  "$HOME_DIR/chat_messages.jsonl" "$HOME_DIR/posts.jsonl" "$HOME_DIR/reading" "$HOME_DIR/uploads"
  "$HOME_DIR/checkin_log.jsonl" "$HOME_DIR/ring_latest.json" "$HOME_DIR/ring_log.jsonl"
  "$HOME_DIR/events.jsonl" "$HOME_DIR/inbox.jsonl" "$HOME_DIR/qr_meta.json"
  "$HOME_DIR/push_subscriptions.json" "$HOME_DIR/vapid_keys.json"
  "$HOME_DIR/.auth_password" "$HOME_DIR/peek_config.json" "$HOME_DIR/.claude_key"
  /root/free_time_log.jsonl /root/toy/touch_log.jsonl /root/lmc5.sqlite
)
[ -n "${OB_DATA_DIR:-}" ] && CANDIDATES+=("$OB_DATA_DIR")
FILES=()
for p in "${CANDIDATES[@]}"; do [ -e "$p" ] && FILES+=("${p#/}"); done
[ "${#FILES[@]}" -gt 0 ] || { log "nothing to back up"; exit 1; }

OUT="$BACKUP_DIR/data-$STAMP.tar.gz"
TMP="$OUT.part"
log "archiving ${#FILES[@]} items"
tar -czf "$TMP" -C / "${FILES[@]}" 2>/dev/null || [ $? -eq 1 ]      # exit 1 = a file changed while reading: fine for append-only logs
tar -tzf "$TMP" >/dev/null                                          # readable? (fails loudly if not)
if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  [ -r "$BACKUP_PASSPHRASE_FILE" ] || { log "BACKUP_PASSPHRASE_FILE not readable"; rm -f "$TMP"; exit 1; }
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:"$BACKUP_PASSPHRASE_FILE" -in "$TMP" -out "$TMP.enc"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:"$BACKUP_PASSPHRASE_FILE" -in "$TMP.enc" | tar -tz >/dev/null   # decrypts and reads back?
  rm -f "$TMP"; TMP="$TMP.enc"; OUT="$OUT.enc"
fi
mv "$TMP" "$OUT"; chmod 600 "$OUT"
log "wrote $OUT ($(du -h "$OUT" | cut -f1))"

if [ "${BACKUP_PHOTOS:-0}" = "1" ] && [ -d /root/sherry ]; then
  PH="$BACKUP_DIR/photos-$STAMP.tar"; tar -cf "$PH.part" -C / root/sherry && mv "$PH.part" "$PH"; chmod 600 "$PH"
  log "wrote $PH ($(du -h "$PH" | cut -f1))"
fi

# keep the last KEEP_DAYS days, but never delete the newest archive
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'data-*.tar.gz' -o -name 'data-*.tar.gz.enc' -o -name 'photos-*.tar' \) -mtime "+$KEEP_DAYS" -print -delete | sed 's/^/[backup] pruned /'

if [ -n "${BACKUP_REMOTE:-}" ]; then
  case "$BACKUP_REMOTE" in
    rclone:*) rclone copy "$OUT" "${BACKUP_REMOTE#rclone:}" && log "copied to $BACKUP_REMOTE" ;;
    *)        rsync -a "$OUT" "$BACKUP_REMOTE" && log "copied to $BACKUP_REMOTE" ;;
  esac
fi
log "done"
