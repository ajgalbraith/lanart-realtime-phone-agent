#!/bin/zsh
set -euo pipefail

SESSION="lanart-phone-agent"
APP_DIR="/Users/jamesgalbraith/Documents/Codex/2026-05-27/set-up-a-local-app-i"
LOG_DIR="/Users/jamesgalbraith/Library/Logs/lanart-realtime-phone-agent"
NODE="/opt/homebrew/opt/node@22/bin/node"
TMUX="/opt/homebrew/bin/tmux"

mkdir -p "$LOG_DIR"

if "$TMUX" has-session -t "$SESSION" 2>/dev/null; then
  exit 0
fi

exec "$TMUX" new-session -d -s "$SESSION" \
  "cd '$APP_DIR' && PORT=8797 '$NODE' server/index.js >> '$LOG_DIR/stdout.log' 2>> '$LOG_DIR/stderr.log'"
