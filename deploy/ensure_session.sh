#!/usr/bin/env bash
# Idempotent: start the Claude Code tmux session if missing. Run from systemd, or from
# cron every minute as a watchdog:  * * * * * /root/claude-home/deploy/ensure_session.sh
SESSION="${TMUX_TARGET:-claude-tg}"
DIR="${CLAUDE_WORKDIR:-/root}"
tmux has-session -t "$SESSION" 2>/dev/null && exit 0
tmux new-session -d -s "$SESSION" -c "$DIR" "claude --continue || claude"
