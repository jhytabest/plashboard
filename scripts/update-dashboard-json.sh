#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-/var/lib/openclaw/plash-data}"
TARGET_FILE="${TARGET_DIR}/dashboard.json"
TMP_FILE="${TARGET_FILE}.tmp"

mkdir -p "${TARGET_DIR}"

cat >"${TMP_FILE}" <<JSON
{
  "version": "1.0",
  "generated_at": "$(date -u +%FT%TZ)",
  "ttl_seconds": 120,
  "title": "Home Dashboard",
  "summary": "Updated by automation",
  "sections": [
    {
      "id": "automation",
      "label": "Automation",
      "cards": [
        {
          "id": "openclaw",
          "type": "service",
          "title": "OpenClaw",
          "status": "healthy",
          "url": "https://homeserver.tailac3bda.ts.net",
          "description": "Updated by update-dashboard-json.sh",
          "tags": ["automation"],
          "metrics": [
            { "key": "timestamp", "value": "$(date -u +%H:%M:%S)" }
          ],
          "updated_at": "$(date -u +%FT%TZ)"
        }
      ]
    }
  ],
  "alerts": []
}
JSON

mv "${TMP_FILE}" "${TARGET_FILE}"
echo "wrote ${TARGET_FILE}"
