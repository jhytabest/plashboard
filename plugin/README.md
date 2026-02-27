# @jhytabest/plashboard

Template-driven dashboard runtime plugin for OpenClaw.

This plugin manages dashboard templates, scheduled fill runs, validation, and atomic publish to a live `dashboard.json`.

## Install

```bash
openclaw plugins install @jhytabest/plashboard
openclaw plugins enable plashboard
openclaw plugins doctor
```

## Update

```bash
openclaw plugins update plashboard
```

## Minimal Config

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

For real model runs, switch `fill_provider` to `command` and provide `fill_command`.

## Runtime Command

```text
/plashboard setup [mock|command <fill_command>]
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
/plashboard setup mock
/plashboard init
```

Tailscale helper flow:

```text
/plashboard expose-guide
/plashboard expose-check
```

## Notes

- The plugin includes an admin skill (`plashboard-admin`) for tool-guided management.
- Trusted publishing (OIDC) is enabled in CI/CD for npm releases.
