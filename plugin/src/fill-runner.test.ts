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
    allow_command_fill: false,
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
  it('always resets fill session before and after openclaw fill', async () => {
    const calls: string[][] = [];
    const commandRunner = vi.fn(async (argv: string[], _options: unknown) => {
      calls.push(argv);
      if (argv[0] === 'openclaw' && argv[1] === 'gateway' && argv[2] === 'call' && argv[3] === 'sessions.reset') {
        return {
          stdout: '{"ok":true}',
          stderr: '',
          code: 0
        };
      }
      if (argv[0] === 'openclaw' && argv[1] === 'agent') {
        return {
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
        };
      }
      return {
        stdout: '',
        stderr: `unsupported command: ${argv.join(' ')}`,
        code: 1
      };
    });

    const runner = createFillRunner(
      config({ fill_provider: 'openclaw', openclaw_fill_agent_id: 'ops' }),
      { commandRunner }
    );
    const response = await runner.run(context());

    expect(response.values.summary).toBe('new summary');
    expect(commandRunner).toHaveBeenCalledTimes(3);

    const [firstCall, secondCall, thirdCall] = calls;
    expect(firstCall.slice(0, 4)).toEqual(['openclaw', 'gateway', 'call', 'sessions.reset']);
    expect(secondCall.slice(0, 2)).toEqual(['openclaw', 'agent']);
    expect(thirdCall.slice(0, 4)).toEqual(['openclaw', 'gateway', 'call', 'sessions.reset']);

    expect(secondCall).toContain('--agent');
    expect(secondCall).toContain('ops');
    expect(secondCall).not.toContain('--session-id');

    for (const resetCall of [firstCall, thirdCall]) {
      const paramsIndex = resetCall.indexOf('--params');
      expect(paramsIndex).toBeGreaterThan(-1);
      const params = JSON.parse(resetCall[paramsIndex + 1]) as { key?: string; reason?: string };
      expect(params.key).toBe('agent:ops:main');
      expect(params.reason).toBe('new');
    }
  });

  it('fails fill when pre-run session reset fails', async () => {
    const commandRunner = vi.fn(async (argv: string[], _options: unknown) => {
      if (argv[0] === 'openclaw' && argv[1] === 'gateway' && argv[2] === 'call' && argv[3] === 'sessions.reset') {
        return {
          stdout: '',
          stderr: 'reset failed',
          code: 1
        };
      }
      return {
        stdout: '',
        stderr: `unsupported command: ${argv.join(' ')}`,
        code: 1
      };
    });

    const runner = createFillRunner(
      config({
        fill_provider: 'openclaw',
        openclaw_fill_agent_id: 'ops'
      }),
      { commandRunner }
    );

    await expect(runner.run(context())).rejects.toThrow(/session reset failed/i);
    expect(commandRunner).toHaveBeenCalledTimes(1);
  });

  it('post-run session reset failure is safe and does not fail fill output', async () => {
    let resetCalls = 0;
    const commandRunner = vi.fn(async (argv: string[], _options: unknown) => {
      if (argv[0] === 'openclaw' && argv[1] === 'gateway' && argv[2] === 'call' && argv[3] === 'sessions.reset') {
        resetCalls += 1;
        if (resetCalls === 1) {
          return {
            stdout: '{"ok":true}',
            stderr: '',
            code: 0
          };
        }
        return {
          stdout: '',
          stderr: 'reset failed',
          code: 1
        };
      }
      if (argv[0] === 'openclaw' && argv[1] === 'agent') {
        return {
          stdout: '{"values":{"summary":"new summary"}}',
          stderr: '',
          code: 0
        };
      }
      return {
        stdout: '',
        stderr: `unsupported command: ${argv.join(' ')}`,
        code: 1
      };
    });

    const runner = createFillRunner(
      config({
        fill_provider: 'openclaw',
        openclaw_fill_agent_id: 'ops'
      }),
      { commandRunner }
    );
    const response = await runner.run(context());

    expect(response.values.summary).toBe('new summary');
    expect(commandRunner).toHaveBeenCalledTimes(3);
    expect(commandRunner.mock.calls[2][0].slice(0, 4)).toEqual(['openclaw', 'gateway', 'call', 'sessions.reset']);
  });

  it('parses command runner fenced json output', async () => {
    const commandRunner = vi.fn(async (_argv: string[], _options: unknown) => ({
      stdout: '```json\n{"values":{"summary":"from command"}}\n```',
      stderr: '',
      code: 0
    }));

    const runner = createFillRunner(
      config({ fill_provider: 'command', allow_command_fill: true, fill_command: 'echo "$PLASHBOARD_PROMPT_JSON"' }),
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

  it('rejects command fill when allow_command_fill is false', async () => {
    const commandRunner = vi.fn(async () => ({
      stdout: '{"values":{"summary":"from command"}}',
      stderr: '',
      code: 0
    }));

    const runner = createFillRunner(
      config({ fill_provider: 'command', allow_command_fill: false, fill_command: 'echo hello' }),
      { commandRunner }
    );

    await expect(runner.run(context())).rejects.toThrow(/allow_command_fill=true/);
    expect(commandRunner).not.toHaveBeenCalled();
  });
});
