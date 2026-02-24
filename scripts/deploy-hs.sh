#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="/srv/home-stack/plash-dashboard"

cd "$ROOT_DIR"

rsync -az --delete --exclude .git ./ hs:"${REMOTE_DIR}/"
ssh hs "set -euo pipefail; cd ${REMOTE_DIR}; docker compose up -d; tailscale serve --bg --yes --https=8444 18888; tailscale serve status; curl -fsSI http://127.0.0.1:18888/healthz | sed -n '1,20p'"

echo "Deployed: https://homeserver.tailac3bda.ts.net:8444/"
