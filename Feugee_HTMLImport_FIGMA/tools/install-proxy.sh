#!/bin/bash
# Feugee HTML Import - run the local CORS proxy at login (macOS LaunchAgent).
#   bash tools/install-proxy.sh             install + start (127.0.0.1:8787)
#   bash tools/install-proxy.sh --uninstall stop + remove
# Binds to localhost only; stdlib Python; restarts itself if it dies.
set -euo pipefail

LABEL="com.feugee.htmlimport-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY="$DIR/cors-proxy.py"
PORT="${PORT:-8787}"
LOG="$HOME/Library/Logs/feugee-htmlimport-proxy.log"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

PY="$(command -v python3)"
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$PY</string><string>$PROXY</string><string>$PORT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/?url=https://example.com/"; then
    echo "proxy running on http://127.0.0.1:$PORT (starts at login; log: $LOG)"
    exit 0
  fi
  sleep 0.5
done
echo "proxy did not answer on :$PORT - see $LOG" >&2
exit 1
