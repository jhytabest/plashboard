import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { registerPlashboardPlugin } from './plugin.js';

type ToolDef = {
  name: string;
  execute?: (toolCallId: unknown, params?: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
};

function parseToolJson(result: { content: Array<{ type: string; text: string }> }) {
  const text = result.content[0]?.text || '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('registerPlashboardPlugin', () => {
  it('doctor reports readiness flags when runtime command runner is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plashboard-plugin-test-'));
    try {
      const tools = new Map<string, ToolDef>();

      registerPlashboardPlugin({
        pluginConfig: {
          config: {
            data_dir: root,
            dashboard_output_path: join(root, 'dashboard.json'),
            fill_provider: 'openclaw',
            allow_command_fill: false
          }
        },
        registerTool: (definition: unknown) => {
          const tool = definition as ToolDef;
          tools.set(tool.name, tool);
        },
        registerCommand: () => {},
        registerService: () => {},
        runtime: {
          config: {
            loadConfig: () => ({}),
            writeConfigFile: async () => {}
          }
        }
      });

      const doctor = tools.get('plashboard_doctor');
      expect(doctor?.execute).toBeTypeOf('function');

      const result = await doctor!.execute!('tool-1', {
        local_url: 'http://127.0.0.1:9'
      });
      const payload = parseToolJson(result);
      const data = (payload.data || {}) as Record<string, unknown>;

      expect(payload.ok).toBe(false);
      expect(data.fill_provider_ready).toBe(false);
      expect(data.writer_runner_ready).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('setup rejects command provider unless allow_command_fill is true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plashboard-plugin-test-'));
    try {
      const tools = new Map<string, ToolDef>();
      let writtenConfig: unknown;

      registerPlashboardPlugin({
        pluginConfig: {
          config: {
            data_dir: root,
            dashboard_output_path: join(root, 'dashboard.json'),
            fill_provider: 'openclaw',
            allow_command_fill: false
          }
        },
        registerTool: (definition: unknown) => {
          const tool = definition as ToolDef;
          tools.set(tool.name, tool);
        },
        registerCommand: () => {},
        registerService: () => {},
        runtime: {
          config: {
            loadConfig: () => ({}),
            writeConfigFile: async (nextConfig: unknown) => {
              writtenConfig = nextConfig;
            }
          },
          system: {
            runCommandWithTimeout: async (argv: string[]) => {
              if (argv[0] === 'python3' && argv[1] === '--version') {
                return {
                  stdout: 'Python 3.12.0',
                  stderr: '',
                  code: 0,
                  termination: 'exit'
                };
              }
              return {
                stdout: '',
                stderr: `unsupported command: ${argv.join(' ')}`,
                code: 1,
                termination: 'exit'
              };
            }
          }
        }
      });

      const setup = tools.get('plashboard_setup');
      expect(setup?.execute).toBeTypeOf('function');

      const rejected = parseToolJson(await setup!.execute!('tool-2', {
        fill_provider: 'command',
        fill_command: 'echo hello'
      }));

      expect(rejected.ok).toBe(false);
      expect((rejected.errors as string[]).join(' ')).toMatch(/allow_command_fill=true/i);
      expect(writtenConfig).toBeUndefined();

      const accepted = parseToolJson(await setup!.execute!('tool-3', {
        fill_provider: 'command',
        allow_command_fill: true,
        fill_command: 'echo hello'
      }));

      expect(accepted.ok).toBe(true);
      expect((accepted.data as Record<string, unknown>).allow_command_fill).toBe(true);
      expect(writtenConfig).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('permissions fix normalizes directory and dashboard file modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plashboard-plugin-test-'));
    const dashboardPath = join(root, 'dashboard.json');
    try {
      const tools = new Map<string, ToolDef>();
      await writeFile(dashboardPath, '{"ok":true}\n', 'utf8');
      await chmod(root, 0o700);
      await chmod(dashboardPath, 0o600);

      registerPlashboardPlugin({
        pluginConfig: {
          config: {
            data_dir: root,
            dashboard_output_path: dashboardPath,
            fill_provider: 'openclaw',
            allow_command_fill: false
          }
        },
        registerTool: (definition: unknown) => {
          const tool = definition as ToolDef;
          tools.set(tool.name, tool);
        },
        registerCommand: () => {},
        registerService: () => {},
        runtime: {
          config: {
            loadConfig: () => ({}),
            writeConfigFile: async () => {}
          }
        }
      });

      const fix = tools.get('plashboard_permissions_fix');
      expect(fix?.execute).toBeTypeOf('function');

      const result = parseToolJson(await fix!.execute!('tool-4', {}));
      expect(result.ok).toBe(true);

      const dirMode = (await stat(root)).mode & 0o777;
      const fileMode = (await stat(dashboardPath)).mode & 0o777;
      expect(dirMode).toBe(0o755);
      expect(fileMode).toBe(0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
