#!/usr/bin/env bash
# Install / reinstall the recorder, hourly compaction and the health report as per-user launchd
# agents (macOS). The recorder restarts on any exit, starts at login, and runs under caffeinate.
#   ops/install-recorder.sh            install + start
#   ops/install-recorder.sh uninstall  stop + remove
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABELS=(com.raintrade.recorder com.raintrade.compact com.raintrade.health)
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

stop_all() {
  for l in "${LABELS[@]}"; do launchctl bootout "$DOMAIN/$l" 2>/dev/null || true; done
}

if [[ "${1:-}" == "uninstall" ]]; then
  stop_all
  for l in "${LABELS[@]}"; do rm -f "$AGENTS/$l.plist"; done
  echo "removed ${LABELS[*]}"
  exit 0
fi

NODE="$(command -v node)"
[[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ]] || { echo "need node >= 24 (found $NODE)"; exit 1; }
[[ -d "$REPO/node_modules" ]] || { echo "run 'pnpm install' first"; exit 1; }

# two recorders would append to the same hour file; refuse if one runs outside launchd
if pgrep -f "node apps/harness-recorder/src/main.ts" >/dev/null && ! launchctl print "$DOMAIN/com.raintrade.recorder" >/dev/null 2>&1; then
  echo "a recorder is already running outside launchd (pid $(pgrep -f 'node apps/harness-recorder/src/main.ts' | head -1)); stop it first"
  exit 1
fi

mkdir -p "$REPO/data" "$AGENTS"
stop_all
for l in "${LABELS[@]}"; do
  sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" "$REPO/ops/launchd/$l.plist.template" > "$AGENTS/$l.plist"
  plutil -lint -s "$AGENTS/$l.plist"
  launchctl bootstrap "$DOMAIN" "$AGENTS/$l.plist"
done
echo "installed ${LABELS[*]}"
echo "logs:    tail -f $REPO/data/recorder.log"
echo "status:  cat $REPO/data/status.json"
echo "check:   launchctl print $DOMAIN/com.raintrade.recorder | grep -E 'state|pid'"
