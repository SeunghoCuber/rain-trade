#!/usr/bin/env bash
# Run the recorder in the foreground. On macOS the recorder keeps the machine awake itself
# (recorder.preventSleep → caffeinate -is -w <pid>): -i no idle sleep, -s no system sleep on AC power.
# Closing a laptop lid still sleeps the Mac unless it is in clamshell mode with power + external display.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node apps/harness-recorder/src/main.ts "${1:-config/default.yaml}"
