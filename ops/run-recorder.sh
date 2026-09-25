#!/usr/bin/env bash
# Run the recorder in the foreground. On macOS, caffeinate keeps the machine awake while it runs:
#   -i  no idle sleep (always)   -s  no system sleep (only on AC power)
# Closing a laptop lid still sleeps the Mac unless it is in clamshell mode with power + external display.
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG="${1:-config/default.yaml}"
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -is node apps/harness-recorder/src/main.ts "$CONFIG"
fi
exec node apps/harness-recorder/src/main.ts "$CONFIG"
