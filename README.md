# plash-dashboard

Containerized placeholder UI for a private Plash dashboard exposed over Tailscale MagicDNS only.

## Contract
- Primary data file: `data/dashboard.json`
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
rsync -az --delete --exclude .git ./ hs:/srv/home-stack/plash-dashboard/
ssh hs 'cd /srv/home-stack/plash-dashboard && docker compose up -d'
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
bash scripts/update-dashboard-json.sh /srv/home-stack/plash-dashboard/data
```
