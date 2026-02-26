# plash-dashboard

Template-driven dashboard runtime for OpenClaw.

The plugin manages templates, schedules, OpenClaw fills, validation, and atomic publish.
The dashboard UI consumes one live payload (`dashboard.json`) from the configured data directory.

## Structure
- UI: `site/`
- Nginx config: `nginx/default.conf`
- Compose stack (optional local UI): `docker-compose.yml`
- Dashboard schema: `schema/dashboard.schema.json`
- Template schema: `schema/template.schema.json`
- Fill response schema: `schema/fill-response.schema.json`
- Plugin runtime: `plugin/`
  - `plugin/openclaw.plugin.json`
  - `plugin/src/`
  - `plugin/scripts/dashboard_write.py`
  - `plugin/skills/plashboard-admin/SKILL.md`
- Admin skill mirror: `skills/plashboard-admin/`

## Plugin Responsibilities
- Multi-template storage and validation
- One active template pointer
- Interval schedule execution
- Fill response contract (`{"values": {...}}`)
- Field merge into fixed dashboard skeleton
- Validation + layout budget gate
- Atomic publish to live dashboard
- Run artifacts and status tracking

## Skill Responsibilities
`plashboard-admin` is command/tool guidance only:
- template create/update/copy/delete/list/activate/validate
- run-now trigger
- runtime status
- display profile update

It must not edit JSON files directly or manage infrastructure.

## Plugin Dev Setup
```bash
cd plugin
npm install
npm run typecheck
npm test
```

## Official User Install Route
Install via OpenClaw plugin manager (package manager route):

```bash
openclaw plugins install @jhytabest/plashboard
openclaw plugins enable plashboard
openclaw plugins doctor
```

If distributed via npm, users update with:

```bash
openclaw plugins update plashboard
```

## Global Deployment Pipeline
This repo now supports a standard global publish flow:
- `CI` workflow runs on every push/PR to `main`:
  - `npm ci`
  - `npm run typecheck`
  - `npm test`
  - `npm pack --dry-run`
- `Release` workflow runs on tag push (`v*`) and publishes `@jhytabest/plashboard` to npm.

Maintainer release steps:

```bash
cd plugin
npm install
npm run typecheck
npm test

# choose next version
npm version patch

git push origin main --follow-tags
```

Required one-time GitHub setup:
- Add repository secret `NPM_TOKEN` (npm automation token with publish rights to `@jhytabest` scope).
- Ensure GitHub Actions is enabled for the repo.

After release completes, users install/update with:

```bash
openclaw plugins install @jhytabest/plashboard
openclaw plugins enable plashboard
openclaw plugins update plashboard
```

## Local Development Install
For local development from a checked-out repo:

```bash
cd plugin
npm install --omit=dev
openclaw plugins install /absolute/path/to/repo/plugin --link
openclaw plugins enable plashboard
```

After code changes, restart gateway to load updated plugin code.

## OpenClaw Config Example
Add plugin config in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "plashboard": {
        "enabled": true,
        "config": {
          "data_dir": "/var/lib/openclaw/plash-data",
          "scheduler_tick_seconds": 30,
          "max_parallel_runs": 1,
          "default_retry_count": 1,
          "retry_backoff_seconds": 20,
          "session_timeout_seconds": 90,
          "fill_provider": "mock",
          "display_profile": {
            "width_px": 1920,
            "height_px": 1080,
            "safe_top_px": 96,
            "safe_bottom_px": 106,
            "safe_side_px": 28,
            "layout_safety_margin_px": 24
          }
        }
      }
    }
  }
}
```

Use `fill_provider: "command"` with `fill_command` to call a real OpenClaw session command.
The command receives `PLASHBOARD_PROMPT_JSON` and must print strict JSON response.

## Writer Script
`plugin/scripts/dashboard_write.py` supports:
- `--validate-only`
- `--output <path>`
- `--touch-generated-at`

## Dashboard Contract (v3)
- Schema: `schema/dashboard.schema.json`
- Live payload requires:
  - `version` (`3.x`) and `generated_at` (set by writer)
  - `title`, `ui.timezone`, `sections`
- Sections/cards are content-only; layout is computed by UI.
- Alerts rotate in UI and are not capped in JSON.
