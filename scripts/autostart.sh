#!/bin/bash
# Manage the macOS LaunchAgent that auto-starts Audio-Interpreter at login
# (and restarts it if it ever stops).
#
#   scripts/autostart.sh install     # set up + start auto-launch at login
#   scripts/autostart.sh uninstall   # remove auto-launch entirely
#   scripts/autostart.sh stop        # stop now (comes back at next login)
#   scripts/autostart.sh restart     # restart now
#   scripts/autostart.sh status      # is it running?
#   scripts/autostart.sh logs        # tail the server log
set -euo pipefail

LABEL="com.lgvcmedia.audio-interpreter"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/audio-interpreter.log"
DOMAIN="gui/$(id -u)"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$DIR/.venv/bin/python"

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$DIR/app.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
EOF
}

case "${1:-status}" in
  install)
    [ -x "$PYTHON" ] || { echo "missing venv: $PYTHON (run: python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt)"; exit 1; }
    write_plist
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl enable "$DOMAIN/$LABEL"
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "installed — auto-starts at login. http://127.0.0.1:8765/"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "uninstalled"
    ;;
  stop)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    echo "stopped (will start again at next login, or run: $0 install)"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "restarted"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =" | head -3
      echo "health: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/api/config || echo down)"
    else
      echo "not loaded (run: $0 install)"
    fi
    ;;
  logs)
    tail -f "$LOG"
    ;;
  *)
    echo "usage: $0 {install|uninstall|stop|restart|status|logs}"
    exit 1
    ;;
esac
