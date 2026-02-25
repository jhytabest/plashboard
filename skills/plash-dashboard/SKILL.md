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
- Keep `version` in `3.x`.
- Keep stable IDs for sections/cards/alerts when updating existing items.
- Do not include per-card or per-alert `updated_at`.
- Do not include card `status` or `tags`.
- The writer enforces a viewport fit budget. If validation fails with `layout budget exceeded`, revise content and retry.
- Retry order on layout failure:
  1) Hide lowest-priority cards (`layout.priority`/`priority` high number = lower priority).
  2) Shorten long descriptions and large metric lists.
  3) Keep alerts unlimited in JSON (alerts rotate in UI), but keep section card volume within fit budget.

## Contract Notes (v3)
- `ui` is required:
  - `timezone`: IANA zone (default `Europe/Berlin`)
  - `motion`: `none|subtle`
  - `gutters`: `{ top, bottom, side }` in pixels
- Optional chart support on cards via `chart`:
  - `kind`: `sparkline|bars`
  - `points`: numeric array (at least 2 values)
  - optional `label`, `unit`
- Layout control is direct only (no variants):
  - sections: `hidden`, `order`, `layout`
  - cards: `hidden`, `priority`, `layout`
- Cards require: `id`, `type`, `title`
- Alerts require: `id`, `severity`, `message`
