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
rsync -az --delete ./ hs:/srv/home-stack/plash-dashboard/
ssh hs 'cd /srv/home-stack/plash-dashboard && docker compose up -d'
```

## Expose on MagicDNS (existing homeserver URL under /plash)
This keeps existing `/` route untouched and adds `/plash/`.

```bash
ssh hs '
set -euo pipefail
cfg=$(mktemp)
new=$(mktemp)

tailscale serve get-config > "$cfg"

jq '
  .Web["homeserver.tailac3bda.ts.net:443"].Handlers["/plash/"] = {"Proxy":"http://127.0.0.1:18888"}
' "$cfg" > "$new"

tailscale serve set-config "$new"
tailscale serve status
'
```

Then open:
- `https://homeserver.tailac3bda.ts.net/plash/`
- `https://homeserver/plash/` (if short MagicDNS resolves)

## Automation updates
Use atomic writes to avoid partial JSON reads:
```bash
bash scripts/update-dashboard-json.sh /srv/home-stack/plash-dashboard/data
```
