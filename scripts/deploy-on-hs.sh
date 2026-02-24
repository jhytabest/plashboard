#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-/srv/home-stack/plash-dashboard}"
DATA_DIR="/var/lib/openclaw/plash-data"
SKILL_SRC="${ROOT_DIR}/skills/plash-dashboard"
SKILL_DST="/var/lib/openclaw/.openclaw/workspace/skills/plash-dashboard"

cd "${ROOT_DIR}"

mkdir -p "${DATA_DIR}"
if [ ! -f "${DATA_DIR}/dashboard.json" ]; then
  if [ -f data/dashboard.json ]; then
    cp data/dashboard.json "${DATA_DIR}/dashboard.json"
  elif [ -f data/dashboard.template.json ]; then
    cp data/dashboard.template.json "${DATA_DIR}/dashboard.json"
  else
    echo "missing dashboard seed file (data/dashboard.json or data/dashboard.template.json)" >&2
    exit 1
  fi
fi

chown -R openclaw:openclaw "${DATA_DIR}"
chmod 2775 "${DATA_DIR}"
find "${DATA_DIR}" -type f -name '*.json' -exec chmod 664 {} +

if command -v setfacl >/dev/null 2>&1; then
  setfacl -m u:101:r-x "${DATA_DIR}" || true
  setfacl -m d:u:101:r-x "${DATA_DIR}" || true
  if [ -f "${DATA_DIR}/dashboard.json" ]; then
    setfacl -m u:101:r-- "${DATA_DIR}/dashboard.json" || true
    setfacl -m g::rw-,m::rw- "${DATA_DIR}/dashboard.json" || true
  fi
fi

if [ -d "${SKILL_SRC}" ]; then
  mkdir -p "${SKILL_DST}"
  rsync -az --delete "${SKILL_SRC}/" "${SKILL_DST}/"
  chown -R openclaw:openclaw "${SKILL_DST}"
  find "${SKILL_DST}" -type d -exec chmod 775 {} +
  find "${SKILL_DST}" -type f -name '*.py' -exec chmod 775 {} +
  find "${SKILL_DST}" -type f -name '*.md' -exec chmod 664 {} +
fi

docker compose up -d
tailscale serve --bg --yes --https=8444 18888

if systemctl is-enabled openclaw-gateway.service >/dev/null 2>&1; then
  systemctl restart openclaw-gateway.service
fi

tailscale serve status
curl -fsSI http://127.0.0.1:18888/healthz | sed -n '1,20p'
stat -c '%U:%G %a %n' "${DATA_DIR}" "${DATA_DIR}/dashboard.json"
sudo -u openclaw openclaw skills info plash-dashboard | sed -n '1,80p'
echo "Deployed: https://homeserver.tailac3bda.ts.net:8444/"
