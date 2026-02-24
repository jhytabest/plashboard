# plash-dashboard

Containerized placeholder UI for a private Plash dashboard exposed over Tailscale MagicDNS only.

## Contract
- Runtime data file (automation-owned): `/var/lib/openclaw/plash-data/dashboard.json`
- Seed template (repo-owned): `data/dashboard.template.json`
- Schema: `schema/dashboard.schema.json`
- Versioning: `version` stays in `1.x` for additive-only changes

## Local run
```bash
docker compose up -d
curl -I http://127.0.0.1:18888/healthz
```

## Deploy to homeserver
```bash
ssh hs 'mkdir -p /srv/home-stack/plash-dashboard'
rsync -az --delete --no-owner --no-group --exclude .git --exclude data/dashboard.json ./ hs:/srv/home-stack/plash-dashboard/
ssh hs 'cd /srv/home-stack/plash-dashboard && \
  mkdir -p /var/lib/openclaw/plash-data && \
  [ -f /var/lib/openclaw/plash-data/dashboard.json ] || ( [ -f data/dashboard.json ] && cp data/dashboard.json /var/lib/openclaw/plash-data/dashboard.json || cp data/dashboard.template.json /var/lib/openclaw/plash-data/dashboard.json ) && \
  chown -R openclaw:openclaw /var/lib/openclaw/plash-data && \
  chmod 2775 /var/lib/openclaw/plash-data && \
  find /var/lib/openclaw/plash-data -type f -name "*.json" -exec chmod 664 {} + && \
  if command -v setfacl >/dev/null 2>&1; then \
    setfacl -m u:101:r-x /var/lib/openclaw/plash-data || true; \
    setfacl -m d:u:101:r-x /var/lib/openclaw/plash-data || true; \
    [ -f /var/lib/openclaw/plash-data/dashboard.json ] && setfacl -m u:101:r-- /var/lib/openclaw/plash-data/dashboard.json || true; \
  fi && \
  docker compose up -d'
```

## Expose on MagicDNS (dedicated Plash port)
This keeps existing `https://homeserver.tailac3bda.ts.net/` OpenClaw route untouched and adds a dedicated HTTPS port for Plash.

```bash
ssh hs 'tailscale serve --bg --yes --https=8444 18888 && tailscale serve status'
```

Then open:
- `https://homeserver.tailac3bda.ts.net:8444/`
- `https://homeserver:8444/` (if short MagicDNS resolves)

## Automation updates
Use atomic writes to avoid partial JSON reads:
```bash
bash scripts/update-dashboard-json.sh /var/lib/openclaw/plash-data
```

`openclaw` only needs write access to `/var/lib/openclaw/plash-data`; it does not need sudo, Docker, or access to app code.
ACL note: deploy applies a read ACL for UID `101` (nginx worker in the container) so `dashboard.json` remains readable even after restrictive writes.
