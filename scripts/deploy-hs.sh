#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="/srv/home-stack/plash-dashboard"
DATA_DIR="/var/lib/openclaw/plash-data"

cd "$ROOT_DIR"

rsync -az --delete --no-owner --no-group \
  --exclude .git \
  --exclude data/dashboard.json \
  ./ hs:"${REMOTE_DIR}/"

ssh hs "set -euo pipefail; \
  cd ${REMOTE_DIR}; \
  mkdir -p ${DATA_DIR}; \
  if [ ! -f ${DATA_DIR}/dashboard.json ]; then \
    if [ -f data/dashboard.json ]; then cp data/dashboard.json ${DATA_DIR}/dashboard.json; \
    elif [ -f data/dashboard.template.json ]; then cp data/dashboard.template.json ${DATA_DIR}/dashboard.json; fi; \
  fi; \
  chown -R openclaw:openclaw ${DATA_DIR}; \
  chmod 2775 ${DATA_DIR}; \
  find ${DATA_DIR} -type f -name '*.json' -exec chmod 664 {} +; \
  if command -v setfacl >/dev/null 2>&1; then \
    setfacl -m u:101:r-x ${DATA_DIR} || true; \
    setfacl -m d:u:101:r-x ${DATA_DIR} || true; \
    [ -f ${DATA_DIR}/dashboard.json ] && setfacl -m u:101:r-- ${DATA_DIR}/dashboard.json || true; \
  fi; \
  docker compose up -d; \
  tailscale serve --bg --yes --https=8444 18888; \
  tailscale serve status; \
  curl -fsSI http://127.0.0.1:18888/healthz | sed -n '1,20p'; \
  stat -c '%U:%G %a %n' ${DATA_DIR} ${DATA_DIR}/dashboard.json"

echo "Deployed: https://homeserver.tailac3bda.ts.net:8444/"
