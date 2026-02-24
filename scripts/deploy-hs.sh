#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="/srv/home-stack/plash-dashboard"

cd "$ROOT_DIR"

rsync -az --delete --no-owner --no-group \
  --exclude .git \
  --exclude data/dashboard.json \
  ./ hs:"${REMOTE_DIR}/"

ssh hs "set -euo pipefail; \
  cd ${REMOTE_DIR}; \
  mkdir -p data; \
  if [ ! -f data/dashboard.json ] && [ -f data/dashboard.template.json ]; then cp data/dashboard.template.json data/dashboard.json; fi; \
  chown -R openclaw:openclaw data; \
  chmod 2775 data; \
  find data -type f -name '*.json' -exec chmod 664 {} +; \
  docker compose up -d; \
  tailscale serve --bg --yes --https=8444 18888; \
  tailscale serve status; \
  curl -fsSI http://127.0.0.1:18888/healthz | sed -n '1,20p'; \
  stat -c '%U:%G %a %n' data data/dashboard.json"

echo "Deployed: https://homeserver.tailac3bda.ts.net:8444/"
