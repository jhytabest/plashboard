---
name: plashboard-admin
description: Manage plashboard templates, activation, copy/delete, run-now triggers, and display profile using plashboard plugin tools.
command-dispatch: tool
---

# Plashboard Admin

Use this skill for plashboard runtime administration.

## Use Cases
- Create, update, copy, delete, and validate dashboard templates.
- Activate a template as the live dashboard source.
- Trigger immediate runs.
- Inspect runtime status and schedule health.
- Adjust display profile for layout budget checks.

## Required Tooling
Always use plugin tools:
- `plashboard_onboard`
- `plashboard_setup`
- `plashboard_exposure_guide`
- `plashboard_exposure_check`
- `plashboard_web_guide`
- `plashboard_doctor`
- `plashboard_init`
- `plashboard_quickstart`
- `plashboard_template_create`
- `plashboard_template_update`
- `plashboard_template_list`
- `plashboard_template_activate`
- `plashboard_template_copy`
- `plashboard_template_delete`
- `plashboard_template_validate`
- `plashboard_run_now`
- `plashboard_status`
- `plashboard_display_profile_set`

## Guardrails
- Never edit `/var/lib/openclaw/plash-data/dashboard.json` directly.
- Never edit template/state/run JSON files directly.
- Never perform Docker, Tailscale, or systemd operations.
- Never ask the model to generate full dashboard structure when filling values.

## Command Shortcuts
- `/plashboard onboard <description> [local_url] [https_port] [repo_dir]`
- `/plashboard quickstart <description>`
- `/plashboard setup [openclaw [agent_id]|mock|command <fill_command>]`
- `/plashboard doctor [local_url] [https_port] [repo_dir]`
- `/plashboard web-guide [local_url] [repo_dir]`
- `/plashboard expose-guide [local_url] [https_port]`
- `/plashboard expose-check [local_url] [https_port]`
- `/plashboard init`
- `/plashboard status`
- `/plashboard list`
- `/plashboard activate <template-id>`
- `/plashboard copy <source-template-id> <new-template-id> [new-name] [activate]`
- `/plashboard delete <template-id>`
- `/plashboard run <template-id>`
- `/plashboard set-display <width> <height> <safe_top> <safe_bottom>`
