# @jhytabest/plashboard

Template-driven dashboard runtime plugin for OpenClaw.

This plugin manages dashboard templates, scheduled fill runs, validation, and atomic publish to a live `dashboard.json`.

## Install

```bash
openclaw plugins install @jhytabest/plashboard
openclaw plugins enable plashboard
sudo systemctl restart openclaw-gateway
openclaw plugins doctor
```

## Update

```bash
openclaw plugins update plashboard
```

## Zero-Config First Run

No manual config is required for first use. Defaults are safe:
- `fill_provider=openclaw`
- `openclaw_fill_agent_id=main`
- automatic init on service start
- automatic starter template seed when template store is empty

In chat, run:

```text
/plashboard onboard <what this dashboard should focus on>
```

## Optional Config

Add to `openclaw.json`:

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
          "auto_seed_template": true,
          "fill_provider": "openclaw",
          "openclaw_fill_agent_id": "main",
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

`fill_provider: "openclaw"` is the default real mode and calls `openclaw agent` directly.
Use `fill_provider: "command"` only if you need a custom external runner.

## Runtime Command

```text
/plashboard onboard <description> [local_url] [https_port] [repo_dir]
/plashboard setup [openclaw [agent_id]|mock|command <fill_command>]
/plashboard quickstart <description>
/plashboard doctor [local_url] [https_port] [repo_dir]
/plashboard web-guide [local_url] [repo_dir]
/plashboard expose-guide [local_url] [https_port]
/plashboard expose-check [local_url] [https_port]
/plashboard init
/plashboard status
/plashboard list
/plashboard activate <template-id>
/plashboard copy <source-template-id> <new-template-id> [new-name] [activate]
/plashboard delete <template-id>
/plashboard run <template-id>
/plashboard set-display <width> <height> <safe_top> <safe_bottom>
```

Recommended first run:

```text
/plashboard onboard "Focus on service health, priorities, blockers, and next actions."
```

If `onboard` returns web/exposure warnings:

```text
/plashboard web-guide
/plashboard expose-guide
/plashboard doctor
```

Tailscale helper flow:

```text
/plashboard expose-guide
/plashboard expose-check
```

## Notes

- The plugin includes an admin skill (`plashboard-admin`) for tool-guided management.
- Trusted publishing (OIDC) is enabled in CI/CD for npm releases.
