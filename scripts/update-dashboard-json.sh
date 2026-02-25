#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-/var/lib/openclaw/plash-data}"
TARGET_FILE="${TARGET_DIR}/dashboard.json"
TMP_FILE="${TARGET_FILE}.tmp"

mkdir -p "${TARGET_DIR}"

cat >"${TMP_FILE}" <<JSON
{
  "version": "3.0",
  "generated_at": "$(date -u +%FT%TZ)",
  "ttl_seconds": 120,
  "title": "Home Dashboard",
  "summary": "Updated by automation",
  "ui": {
    "timezone": "Europe/Berlin",
    "motion": "subtle",
    "gutters": {
      "top": 56,
      "bottom": 106,
      "side": 28
    }
  },
  "sections": [
    {
      "id": "automation",
      "label": "Automation",
      "order": 10,
      "layout": { "span": 6 },
      "cards": [
        {
          "id": "openclaw",
          "title": "OpenClaw",
          "url": "https://homeserver.tailac3bda.ts.net",
          "description": "Updated by update-dashboard-json.sh",
          "long_description": "Latest run confirms gateway health and recent automation throughput.",
          "layout": { "span": 12 },
          "chart": {
            "kind": "sparkline",
            "label": "Jobs",
            "points": [2, 2, 3, 2, 3, 4]
          },
          "priority": 10
        }
      ]
    }
  ],
  "alerts": []
}
JSON

mv "${TMP_FILE}" "${TARGET_FILE}"
chmod 664 "${TARGET_FILE}" || true
if command -v setfacl >/dev/null 2>&1; then
  setfacl -m u:101:r-- "${TARGET_FILE}" || true
  setfacl -m g::rw-,m::rw- "${TARGET_FILE}" || true
fi
echo "wrote ${TARGET_FILE}"
