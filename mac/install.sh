#!/bin/bash
# Installs the always-on Mac runner as a LaunchAgent. It starts at login, restarts if it dies,
# pauses when the Mac sleeps (GitHub Actions covers those gaps), and follows origin/main.
# Uninstall: mac/uninstall.sh
set -euo pipefail

LABEL="com.jobradar.runner"
REPO_URL="https://github.com/adityasingh2400/jobradar.git"
BASE="$HOME/.jobradar"
APP="$BASE/app"
LOG="$HOME/Library/Logs/jobradar.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then echo "node not found on PATH" >&2; exit 1; fi
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"
GH_DIR="$(dirname "$(command -v gh || echo /usr/local/bin/gh)")"

mkdir -p "$BASE" "$HOME/Library/Logs" "$HOME/Library/LaunchAgents"
# The runner lives outside ~/Desktop so macOS privacy protection never blocks it.
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin main && git -C "$APP" reset -q --hard origin/main
else
  git clone -q "$REPO_URL" "$APP"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP/radar/run.mjs</string>
    <string>daemon</string>
    <string>--runner</string>
    <string>mac</string>
    <string>--self-update</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):$GH_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "Installed $LABEL"
echo "  code:  $APP"
echo "  data:  $BASE/data"
echo "  logs:  tail -f $LOG"
