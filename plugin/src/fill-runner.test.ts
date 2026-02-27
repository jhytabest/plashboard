import { describe, expect, it, vi } from 'vitest';
import { createFillRunner } from './fill-runner.js';
import type { DashboardTemplate, FillRunContext, PlashboardConfig } from './types.js';

function template(): DashboardTemplate {
  return {
    id: 'ops',
    name: 'Ops',
    enabled: true,
    schedule: {
      mode: 'interval',
      every_minutes: 5,
      timezone: 'UTC'
    },
    base_dashboard: {
      title: 'Ops',
      summary: 'old summary'
    },
    fields: [
      {
        id: 'summary',
        pointer: '/summary',
        type: 'string',
        prompt: 'Summarize current status',
        required: true
      }
    ]
  };
}

function config(overrides: Partial<PlashboardConfig>): PlashboardConfig {
  return {
    data_dir: '/tmp/plash-test',
    timezone: 'UTC',
    scheduler_tick_seconds: 30,
    max_parallel_runs: 1,
    default_retry_count: 0,
    retry_backoff_seconds: 1,
    session_timeout_seconds: 30,
    auto_seed_template: false,
    fill_provider: 'mock',
    fill_command: undefined,
    openclaw_fill_agent_id: 'main',
    python_bin: 'python3',
    writer_script_path: '/tmp/writer.py',
    dashboard_output_path: '/tmp/dashboard.json',
    layout_overflow_tolerance_px: 40,
    display_profile: {
      width_px: 1920,
      height_px: 1080,
      safe_top_px: 96,
      safe_bottom_px: 106,
      safe_side_px: 28,
      layout_safety_margin_px: 24
    },
    model_defaults: {},
    ...overrides
  };
}

function context(): FillRunContext {
  return {
    template: template(),
    currentValues: { summary: 'old summary' },
    attempt: 1
  };
}

describe('createFillRunner', () => {
  it('parses openclaw json envelope output', async () => {
    const commandRunner = vi.fn(async (_argv: string[], _options: unknown) => ({
      stdout: JSON.stringify({
        result: {
          payloads: [
            {
              text: '{"values":{"summary":"new summary"}}'
            }
          ]
        }
      }),
      stderr: '',
      code: 0
    }));

    const runner = createFillRunner(
      config({ fill_provider: 'openclaw', openclaw_fill_agent_id: 'ops' }),
      { commandRunner }
    );
    const response = await runner.run(context());

    expect(response.values.summary).toBe('new summary');
    expect(commandRunner).toHaveBeenCalledTimes(1);
    const firstCall = commandRunner.mock.calls[0];
    const argv = firstCall[0];
    expect(argv.slice(0, 2)).toEqual(['openclaw', 'agent']);
    expect(argv).toContain('--agent');
    expect(argv).toContain('ops');
  });

  it('parses command runner fenced json output', async () => {
    const commandRunner = vi.fn(async (_argv: string[], _options: unknown) => ({
      stdout: '```json\n{"values":{"summary":"from command"}}\n```',
      stderr: '',
      code: 0
    }));

    const runner = createFillRunner(
      config({ fill_provider: 'command', fill_command: 'echo "$PLASHBOARD_PROMPT_JSON"' }),
      { commandRunner }
    );
    const response = await runner.run(context());

    expect(response.values.summary).toBe('from command');
    expect(commandRunner).toHaveBeenCalledTimes(1);
    const firstCall = commandRunner.mock.calls[0];
    const argv = firstCall[0];
    expect(argv.slice(0, 2)).toEqual(['sh', '-lc']);
    const options = firstCall[1] as { env?: Record<string, string> };
    expect(options.env?.PLASHBOARD_PROMPT_JSON).toContain('"template"');
  });
});
