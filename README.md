# plash-dashboard

Containerized placeholder UI for a private Plash dashboard exposed over Tailscale MagicDNS only.

## Structure
- UI: `site/`
- Nginx config: `nginx/default.conf`
- Compose stack: `docker-compose.yml`
- Contract schema: `schema/dashboard.schema.json`
- Seed data template: `data/dashboard.template.json`
- Skill source (repo-owned): `skills/plash-dashboard/`
  - `skills/plash-dashboard/SKILL.md`
  - `skills/plash-dashboard/scripts/dashboard_write.py`
- Local deploy wrapper (Mac -> hs): `scripts/deploy-hs.sh`
- Server deploy entrypoint (runs on hs): `scripts/deploy-on-hs.sh`
- CI deploy workflow: `.github/workflows/deploy-production.yml`

## Runtime Paths (server)
- App code: `/srv/home-stack/plash-dashboard`
- Live data (not in git): `/var/lib/openclaw/plash-data/dashboard.json`
- Installed skill path: `/var/lib/openclaw/.openclaw/workspace/skills/plash-dashboard`

## Local run
```bash
docker compose up -d
curl -I http://127.0.0.1:18888/healthz
```

## Dashboard Contract (v3)
- Schema: `schema/dashboard.schema.json`
- Live payload must be `version: "3.x"` with a required `ui` block:
  - `timezone`: IANA timezone (default `Europe/Berlin`)
  - `motion`: `none|subtle`
  - `gutters`: `{ top, bottom, side }` in pixels
- Sections/cards are content-only; layout and sizing are computed by the UI.
- Cards require `id` and `title`; optional text fields are `description` and `long_description`.
- Cards may include optional `chart` data for rendered sparkline/bar graphs (`label` is shown as legend next to title).
- Alerts can be unbounded in JSON; the UI rotates visible alerts.

## Manual deploy to homeserver
```bash
./scripts/deploy-hs.sh
```

## Auto deploy on push to `main`
Workflow: `.github/workflows/deploy-production.yml`

Required GitHub repository secrets:
- `PROD_SSH_HOST`
- `PROD_SSH_USER`
- `PROD_SSH_KEY`
- `PROD_SSH_PORT` (optional, defaults to `22`)

On each push to `main`, CI:
1. syncs repo files to `/srv/home-stack/plash-dashboard` on `hs`
2. runs `scripts/deploy-on-hs.sh`
3. installs/updates the workspace skill from repo
4. restarts `openclaw-gateway` for fresh skill snapshot
5. verifies health endpoints

## Automation updates
Use atomic writes to avoid partial JSON reads:
```bash
bash scripts/update-dashboard-json.sh /var/lib/openclaw/plash-data
```

`openclaw` only needs write access to `/var/lib/openclaw/plash-data`; it does not need sudo, Docker, or access to app code.
ACL note: deploy applies a read ACL for UID `101` (nginx worker in the container) so `dashboard.json` remains readable even after restrictive writes.

## URL
- `https://homeserver.tailac3bda.ts.net:8444/`
