#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-/var/lib/openclaw/plash-data}"
TARGET_FILE="${TARGET_DIR}/dashboard.json"
TMP_FILE="${TARGET_FILE}.tmp"

mkdir -p "${TARGET_DIR}"

cat >"${TMP_FILE}" <<JSON
{
  "title": "Home Dashboard",
  "summary": "Updated by automation",
  "ui": {
    "timezone": "Europe/Berlin"
  },
  "sections": [
    {
      "id": "automation",
      "label": "Automation",
      "cards": [
        {
          "id": "openclaw",
          "title": "OpenClaw",
          "url": "https://homeserver.tailac3bda.ts.net",
          "description": "Updated by update-dashboard-json.sh",
          "long_description": "Latest run confirms gateway health and recent automation throughput.",
          "chart": {
            "kind": "sparkline",
            "label": "Jobs",
            "points": [2, 2, 3, 2, 3, 4]
          }
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
