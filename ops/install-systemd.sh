#!/usr/bin/env bash
# Install the recorder + hourly compaction + daily health report as systemd units (Linux).
# Run from the repo on the server as the user that should own the data (not root):
#   ops/install-systemd.sh             install + start (asks for sudo)
#   ops/install-systemd.sh uninstall   stop + remove
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"
UNITS=(raintrade-recorder.service raintrade-compact.service raintrade-compact.timer raintrade-health.service raintrade-health.timer)
DEST=/etc/systemd/system

if [[ "${1:-}" == "uninstall" ]]; then
  sudo systemctl disable --now raintrade-recorder.service raintrade-compact.timer raintrade-health.timer 2>/dev/null || true
  for u in "${UNITS[@]}"; do sudo rm -f "$DEST/$u"; done
  sudo systemctl daemon-reload
  echo "removed raintrade units"
  exit 0
fi

[[ "$USER_NAME" != "root" ]] || { echo "run as the data-owning user, not root"; exit 1; }
NODE="$(command -v node)"
[[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ]] || { echo "need node >= 24 (found $NODE)"; exit 1; }
[[ -d "$REPO/node_modules" ]] || { echo "run 'pnpm install' first"; exit 1; }

mkdir -p "$REPO/data"
for u in "${UNITS[@]}"; do
  sed -e "s#__USER__#$USER_NAME#g" -e "s#__REPO__#$REPO#g" -e "s#__NODE__#$NODE#g" "$REPO/ops/systemd/$u" | sudo tee "$DEST/$u" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now raintrade-recorder.service raintrade-compact.timer raintrade-health.timer
echo
systemctl --no-pager status raintrade-recorder.service | head -5
systemctl --no-pager list-timers 'raintrade-*'
echo
echo "logs:    tail -f $REPO/data/recorder.log"
echo "status:  cat $REPO/data/status.json"
