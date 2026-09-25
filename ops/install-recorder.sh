#!/usr/bin/env bash
# Install / reinstall the recorder as a per-user launchd agent (macOS).
#   ops/install-recorder.sh            install + start
#   ops/install-recorder.sh uninstall  stop + remove
set -euo pipefail

LABEL=com.raintrade.recorder
REPO="$(cd "$(dirname "$0")/.." && pwd)"
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

mkdir -p "$REPO/data" "$(dirname "$PLIST")"
sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" "$REPO/ops/launchd/$LABEL.plist.template" > "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL → $PLIST"
echo "logs:   tail -f $REPO/data/recorder.log"
echo "status: cat $REPO/data/status.json"
