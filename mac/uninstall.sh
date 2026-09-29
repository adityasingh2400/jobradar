#!/bin/bash
# Stops and removes the Mac runner. GitHub Actions keeps the radar running on its own.
set -euo pipefail
LABEL="com.jobradar.runner"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL (code and data in ~/.jobradar were left in place; delete that folder to remove them)."
