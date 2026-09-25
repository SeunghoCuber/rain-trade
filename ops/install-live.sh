#!/usr/bin/env bash
# Install / reinstall the live paper trader as a per-user launchd agent (macOS). Needs the recorder
# setup first (ops/install-recorder.sh: node permission, data dir). No real orders are ever sent.
#   ops/install-live.sh            install + start
#   ops/install-live.sh uninstall  stop + remove
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.raintrade.live
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

NODE="$(command -v node)"
[[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ]] || { echo "need node >= 24 (found $NODE)"; exit 1; }
if pgrep -f "node apps/harness-live/src/main.ts config/default.yaml" >/dev/null && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "a live runner is already running outside launchd; stop it first"
  exit 1
fi
mkdir -p "$REPO/data" "$(dirname "$PLIST")"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" "$REPO/ops/launchd/$LABEL.plist.template" > "$PLIST"
plutil -lint -s "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL"
echo "logs:    tail -f $REPO/data/live.log"
echo "status:  cat $REPO/data/live/status.json"
echo "kill:    touch $REPO/data/live/KILL   (stops quoting; remove the file and reinstall to resume)"
