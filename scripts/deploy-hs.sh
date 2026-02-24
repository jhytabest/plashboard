#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="/srv/home-stack/plash-dashboard"

cd "$ROOT_DIR"

rsync -az --delete --no-owner --no-group \
  --exclude .git \
  --exclude data/dashboard.json \
  ./ hs:"${REMOTE_DIR}/"

ssh hs "bash ${REMOTE_DIR}/scripts/deploy-on-hs.sh"
