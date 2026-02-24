---
name: plash-dashboard
description: Update the private Plash dashboard data contract at /var/lib/openclaw/plash-data/dashboard.json. Use when asked to add, update, or remove dashboard sections, cards, alerts, title, or summary shown in Plash.
---

# Plash Dashboard

Use this skill for content changes to the private Plash dashboard.

## Files
- Data (write target): `/var/lib/openclaw/plash-data/dashboard.json`
- Schema (reference): `/srv/home-stack/plash-dashboard/schema/dashboard.schema.json`
- Atomic writer: `scripts/dashboard_write.py`

## Required Workflow
1. Read the current data file and schema file.
2. Prepare a complete updated JSON document in a unique temp file, for example:
   - `tmp=$(mktemp /var/tmp/plash-dashboard.XXXXXX.json)`
3. Apply the update with atomic replace:
   - `python3 {baseDir}/scripts/dashboard_write.py --input "$tmp" --touch-generated-at`
4. Verify:
   - `python3 -m json.tool /var/lib/openclaw/plash-data/dashboard.json >/dev/null`
   - `curl -fsS https://homeserver.tailac3bda.ts.net:8444/data/dashboard.json >/dev/null`

## Guardrails
- Do not use `write`, `edit`, or `apply_patch` directly on dashboard JSON.
- Always update through `scripts/dashboard_write.py`.
- Only modify dashboard content JSON. Do not edit Docker, Tailscale, systemd, or network config.
- Keep `version` in `1.x`.
- Keep stable IDs for sections/cards/alerts when updating existing items.
- Use UTC ISO timestamps (e.g. `2026-02-24T14:20:00Z`).
