import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { DisplayProfile, ToolResponse } from './types.js';
import { resolveConfig } from './config.js';
import { PlashboardRuntime } from './runtime.js';

type UnknownApi = {
  registerTool?: (definition: unknown) => void;
  registerCommand?: (definition: unknown) => void;
  registerService?: (definition: unknown) => void;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  runtime?: {
    config?: {
      loadConfig?: () => unknown;
      writeConfigFile?: (nextConfig: unknown) => Promise<void>;
    };
    system?: {
      runCommandWithTimeout?: (
        argv: string[],
        optionsOrTimeout: number | {
          timeoutMs: number;
          cwd?: string;
          input?: string;
          env?: NodeJS.ProcessEnv;
          windowsVerbatimArguments?: boolean;
          noOutputTimeoutMs?: number;
        }
      ) => Promise<{
        stdout: string;
        stderr: string;
        code: number | null;
        signal?: NodeJS.Signals | null;
        killed?: boolean;
        termination?: string;
      }>;
    };
  };
  config?: unknown;
  pluginConfig?: unknown;
};

function toToolResult<T>(payload: ToolResponse<T>) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload)
      }
    ]
  };
}

function toCommandResult<T>(payload: ToolResponse<T>) {
  return {
    text: JSON.stringify(payload)
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'unknown error';
}

type SetupParams = {
  fill_provider?: 'mock' | 'command' | 'openclaw';
  fill_command?: string;
  openclaw_fill_agent_id?: string;
  data_dir?: string;
  scheduler_tick_seconds?: number;
  session_timeout_seconds?: number;
  width_px?: number;
  height_px?: number;
  safe_top_px?: number;
  safe_bottom_px?: number;
  safe_side_px?: number;
  layout_safety_margin_px?: number;
};

type ExposureParams = {
  local_url?: string;
  tailscale_https_port?: number;
  dashboard_output_path?: string;
};

type CommandExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
};

function normalizeLocalUrl(raw: string | undefined): string {
  const fallback = 'http://127.0.0.1:18888';
  if (!raw || !raw.trim()) return fallback;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function normalizePort(raw: number | undefined, fallback: number): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(1, Math.min(65535, value));
}

function runCommand(binary: string, args: string[], timeoutMs: number): Promise<CommandExecResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CommandExecResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        stdout,
        stderr,
        code: null,
        error: `timed out after ${Math.floor(timeoutMs / 1000)}s`
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        stdout,
        stderr,
        code: null,
        error: asString((error as { message?: unknown }).message) || 'spawn failed'
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code
      });
    });
  });
}

async function buildExposureGuide(resolvedConfig: ReturnType<typeof resolveConfig>, params: ExposureParams = {}) {
  const localUrl = normalizeLocalUrl(params.local_url);
  const httpsPort = normalizePort(asNumber(params.tailscale_https_port), 8444);
  const dashboardPath = (params.dashboard_output_path || resolvedConfig.dashboard_output_path).trim();

  return {
    ok: true,
    errors: [],
    data: {
      local_url: localUrl,
      tailscale_https_port: httpsPort,
      dashboard_output_path: dashboardPath,
      commands: [
        `tailscale serve status`,
        `tailscale serve --https=${httpsPort} ${localUrl}`,
        `tailscale serve status`,
        `tailscale serve --https=${httpsPort} off`
      ],
      checks: [
        `test -f ${dashboardPath}`,
        `curl -I ${localUrl}`
      ],
      notes: [
        'plashboard only writes dashboard JSON; your local UI/server must serve it.',
        'the tailscale mapping reuses your existing tailnet identity.',
        'choose a port not already used by another tailscale serve mapping.'
      ]
    }
  } satisfies ToolResponse<Record<string, unknown>>;
}

async function runExposureCheck(resolvedConfig: ReturnType<typeof resolveConfig>, params: ExposureParams = {}) {
  const localUrl = normalizeLocalUrl(params.local_url);
  const httpsPort = normalizePort(asNumber(params.tailscale_https_port), 8444);
  const dashboardPath = (params.dashboard_output_path || resolvedConfig.dashboard_output_path).trim();
  const errors: string[] = [];

  let dashboardExists = false;
  let dashboardSizeBytes: number | undefined;
  let dashboardMtimeIso: string | undefined;

  try {
    await access(dashboardPath, fsConstants.R_OK);
    const info = await stat(dashboardPath);
    dashboardExists = true;
    dashboardSizeBytes = info.size;
    dashboardMtimeIso = info.mtime.toISOString();
  } catch {
    errors.push(`dashboard file is not readable: ${dashboardPath}`);
  }

  let localUrlOk = false;
  let localStatusCode: number | undefined;
  let localError: string | undefined;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(localUrl, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timer);
    localStatusCode = response.status;
    localUrlOk = response.status >= 200 && response.status < 500;
    if (!localUrlOk) {
      errors.push(`local dashboard URL returned status ${response.status}: ${localUrl}`);
    }
  } catch (error) {
    localError = asErrorMessage(error);
    errors.push(`local dashboard URL is not reachable: ${localUrl} (${localError})`);
  }

  const tailscale = await runCommand('tailscale', ['serve', 'status'], 8000);
  const tailscaleOutput = `${tailscale.stdout}\n${tailscale.stderr}`.trim();
  let tailscalePortConfigured = false;

  if (!tailscale.ok) {
    errors.push(`tailscale serve status failed: ${tailscale.error || tailscale.stderr || `exit ${tailscale.code}`}`);
  } else {
    tailscalePortConfigured = tailscaleOutput.includes(`:${httpsPort}`);
    if (!tailscalePortConfigured) {
      errors.push(`tailscale serve has no mapping for https port ${httpsPort}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    data: {
      dashboard_output_path: dashboardPath,
      dashboard_exists: dashboardExists,
      dashboard_size_bytes: dashboardSizeBytes,
      dashboard_mtime_utc: dashboardMtimeIso,
      local_url: localUrl,
      local_url_ok: localUrlOk,
      local_status_code: localStatusCode,
      local_error: localError,
      tailscale_https_port: httpsPort,
      tailscale_status_ok: tailscale.ok,
      tailscale_port_configured: tailscalePortConfigured,
      tailscale_status_excerpt: tailscaleOutput.slice(0, 1200)
    }
  } satisfies ToolResponse<Record<string, unknown>>;
}

async function runSetup(api: UnknownApi, resolvedConfig: ReturnType<typeof resolveConfig>, params: SetupParams = {}) {
  const loadConfig = api.runtime?.config?.loadConfig;
  const writeConfigFile = api.runtime?.config?.writeConfigFile;

  if (!loadConfig || !writeConfigFile) {
    return {
      ok: false,
      errors: ['setup is unavailable: runtime config API is not exposed by this OpenClaw build']
    } satisfies ToolResponse<Record<string, unknown>>;
  }

  const rootConfig = asObject(loadConfig());
  const plugins = asObject(rootConfig.plugins);
  const entries = asObject(plugins.entries);
  const currentEntry = asObject(entries.plashboard);
  const currentPluginConfig = asObject(currentEntry.config);

  const existingDisplay = asObject(currentPluginConfig.display_profile);
  const displayProfile = {
    width_px: Math.max(
      320,
      Math.floor(asNumber(params.width_px) ?? asNumber(existingDisplay.width_px) ?? resolvedConfig.display_profile.width_px)
    ),
    height_px: Math.max(
      240,
      Math.floor(asNumber(params.height_px) ?? asNumber(existingDisplay.height_px) ?? resolvedConfig.display_profile.height_px)
    ),
    safe_top_px: Math.max(
      0,
      Math.floor(asNumber(params.safe_top_px) ?? asNumber(existingDisplay.safe_top_px) ?? resolvedConfig.display_profile.safe_top_px)
    ),
    safe_bottom_px: Math.max(
      0,
      Math.floor(
        asNumber(params.safe_bottom_px) ?? asNumber(existingDisplay.safe_bottom_px) ?? resolvedConfig.display_profile.safe_bottom_px
      )
    ),
    safe_side_px: Math.max(
      0,
      Math.floor(asNumber(params.safe_side_px) ?? asNumber(existingDisplay.safe_side_px) ?? resolvedConfig.display_profile.safe_side_px)
    ),
    layout_safety_margin_px: Math.max(
      0,
      Math.floor(
        asNumber(params.layout_safety_margin_px)
          ?? asNumber(existingDisplay.layout_safety_margin_px)
          ?? resolvedConfig.display_profile.layout_safety_margin_px
      )
    )
  };

  const currentProvider = asString(currentPluginConfig.fill_provider);
  const selectedProvider =
    params.fill_provider
    || (currentProvider === 'command' || currentProvider === 'mock' || currentProvider === 'openclaw'
      ? currentProvider
      : resolvedConfig.fill_provider);
  const selectedCommand = (
    params.fill_command
    || asString(currentPluginConfig.fill_command)
    || asString(resolvedConfig.fill_command)
  ).trim();
  const selectedAgentId = (
    params.openclaw_fill_agent_id
    || asString(currentPluginConfig.openclaw_fill_agent_id)
    || asString(resolvedConfig.openclaw_fill_agent_id)
    || 'main'
  ).trim();

  if (selectedProvider === 'command' && !selectedCommand) {
    return {
      ok: false,
      errors: ['fill_provider=command requires fill_command']
    } satisfies ToolResponse<Record<string, unknown>>;
  }
  if (selectedProvider === 'openclaw' && !selectedAgentId) {
    return {
      ok: false,
      errors: ['fill_provider=openclaw requires openclaw_fill_agent_id']
    } satisfies ToolResponse<Record<string, unknown>>;
  }

  const nextPluginConfig: Record<string, unknown> = {
    ...currentPluginConfig,
    data_dir: params.data_dir || asString(currentPluginConfig.data_dir) || resolvedConfig.data_dir,
    scheduler_tick_seconds: Math.max(
      5,
      Math.floor(
        asNumber(params.scheduler_tick_seconds)
        ?? asNumber(currentPluginConfig.scheduler_tick_seconds)
        ?? resolvedConfig.scheduler_tick_seconds
      )
    ),
    session_timeout_seconds: Math.max(
      10,
      Math.floor(
        asNumber(params.session_timeout_seconds)
        ?? asNumber(currentPluginConfig.session_timeout_seconds)
        ?? resolvedConfig.session_timeout_seconds
      )
    ),
    fill_provider: selectedProvider,
    display_profile: displayProfile
  };

  if (selectedCommand) {
    nextPluginConfig.fill_command = selectedCommand;
  } else {
    delete nextPluginConfig.fill_command;
  }
  if (selectedProvider === 'openclaw') {
    nextPluginConfig.openclaw_fill_agent_id = selectedAgentId;
  } else {
    delete nextPluginConfig.openclaw_fill_agent_id;
  }

  const nextRootConfig = {
    ...rootConfig,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        plashboard: {
          ...currentEntry,
          enabled: true,
          config: nextPluginConfig
        }
      }
    }
  };

  await writeConfigFile(nextRootConfig);

  return {
    ok: true,
    errors: [],
    data: {
      configured: true,
      restart_required: true,
      plugin_id: 'plashboard',
      fill_provider: selectedProvider,
      fill_command: selectedProvider === 'command' ? selectedCommand : undefined,
      openclaw_fill_agent_id: selectedProvider === 'openclaw' ? selectedAgentId : undefined,
      data_dir: nextPluginConfig.data_dir,
      scheduler_tick_seconds: nextPluginConfig.scheduler_tick_seconds,
      session_timeout_seconds: nextPluginConfig.session_timeout_seconds,
      display_profile: displayProfile,
      next_steps: [
        'restart OpenClaw gateway',
        'run /plashboard init'
      ]
    }
  } satisfies ToolResponse<Record<string, unknown>>;
}

export function registerPlashboardPlugin(api: UnknownApi): void {
  const config = resolveConfig(api);
  const runtimeCommand = api.runtime?.system?.runCommandWithTimeout;
  const fillCommandRunner = runtimeCommand
    ? async (
      argv: string[],
      optionsOrTimeout: number | {
        timeoutMs: number;
        cwd?: string;
        input?: string;
        env?: NodeJS.ProcessEnv;
        windowsVerbatimArguments?: boolean;
        noOutputTimeoutMs?: number;
      }
    ) => {
      const result = await runtimeCommand(argv, optionsOrTimeout);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        signal: result.signal,
        killed: result.killed,
        termination: result.termination
      };
    }
    : undefined;
  const runtime = new PlashboardRuntime(config, {
    info: (...args) => api.logger?.info?.(...args),
    warn: (...args) => api.logger?.warn?.(...args),
    error: (...args) => api.logger?.error?.(...args)
  }, {
    commandRunner: fillCommandRunner
  });

  api.registerService?.({
    id: 'plashboard-scheduler',
    async start() {
      await runtime.start();
    },
    async stop() {
      await runtime.stop();
    }
  });

  api.registerTool?.({
    name: 'plashboard_exposure_guide',
    description: 'Return copy-paste commands to expose dashboard UI over existing Tailscale.',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        local_url: { type: 'string' },
        tailscale_https_port: { type: 'number' },
        dashboard_output_path: { type: 'string' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: ExposureParams = {}) =>
      toToolResult(await buildExposureGuide(config, params))
  });

  api.registerTool?.({
    name: 'plashboard_exposure_check',
    description: 'Check dashboard file, local URL, and tailscale serve mapping health.',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        local_url: { type: 'string' },
        tailscale_https_port: { type: 'number' },
        dashboard_output_path: { type: 'string' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: ExposureParams = {}) =>
      toToolResult(await runExposureCheck(config, params))
  });

  api.registerTool?.({
    name: 'plashboard_setup',
    description: 'Bootstrap or update plashboard plugin configuration in openclaw.json.',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        fill_provider: { type: 'string', enum: ['mock', 'command', 'openclaw'] },
        fill_command: { type: 'string' },
        openclaw_fill_agent_id: { type: 'string' },
        data_dir: { type: 'string' },
        scheduler_tick_seconds: { type: 'number' },
        session_timeout_seconds: { type: 'number' },
        width_px: { type: 'number' },
        height_px: { type: 'number' },
        safe_top_px: { type: 'number' },
        safe_bottom_px: { type: 'number' },
        safe_side_px: { type: 'number' },
        layout_safety_margin_px: { type: 'number' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: SetupParams = {}) =>
      toToolResult(await runSetup(api, config, params))
  });

  api.registerTool?.({
    name: 'plashboard_init',
    description: 'Initialize plashboard state directories and optional default template.',
    optional: true,
    execute: async () => toToolResult(await runtime.init())
  });

  api.registerTool?.({
    name: 'plashboard_template_create',
    description: 'Create a new dashboard template.',
    optional: true,
    parameters: {
      type: 'object',
      required: ['template'],
      properties: {
        template: { type: 'object' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: { template?: unknown } = {}) =>
      toToolResult(await runtime.templateCreate(params.template))
  });

  api.registerTool?.({
    name: 'plashboard_template_update',
    description: 'Update an existing dashboard template.',
    optional: true,
    parameters: {
      type: 'object',
      required: ['template_id', 'template'],
      properties: {
        template_id: { type: 'string' },
        template: { type: 'object' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: { template_id?: string; template?: unknown } = {}) =>
      toToolResult(await runtime.templateUpdate(params.template_id || '', params.template))
  });

  api.registerTool?.({
    name: 'plashboard_template_list',
    description: 'List available dashboard templates with schedule and run state.',
    optional: true,
    execute: async () => toToolResult(await runtime.templateList())
  });

  api.registerTool?.({
    name: 'plashboard_template_activate',
    description: 'Set active dashboard template.',
    optional: true,
    parameters: {
      type: 'object',
      required: ['template_id'],
      properties: {
        template_id: { type: 'string' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: { template_id?: string } = {}) =>
      toToolResult(await runtime.templateActivate(params.template_id || ''))
  });

  api.registerTool?.({
    name: 'plashboard_template_delete',
    description: 'Delete a dashboard template by id.',
    optional: true,
    parameters: {
      type: 'object',
      required: ['template_id'],
      properties: {
        template_id: { type: 'string' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: { template_id?: string } = {}) =>
      toToolResult(await runtime.templateDelete(params.template_id || ''))
  });

  api.registerTool?.({
    name: 'plashboard_template_copy',
    description: 'Copy a dashboard template into a new template id.',
    optional: true,
    parameters: {
      type: 'object',
      required: ['source_template_id', 'new_template_id'],
      properties: {
        source_template_id: { type: 'string' },
        new_template_id: { type: 'string' },
        new_name: { type: 'string' },
        activate: { type: 'boolean' }
      },
      additionalProperties: false
    },
    execute: async (
      _toolCallId: unknown,
      params: {
        source_template_id?: string;
        new_template_id?: string;
        new_name?: string;
        activate?: boolean;
      } = {}
    ) =>
      toToolResult(
        await runtime.templateCopy(
          params.source_template_id || '',
          params.new_template_id || '',
          params.new_name,
          Boolean(params.activate)
        )
      )
  });

  api.registerTool?.({
    name: 'plashboard_template_validate',
    description: 'Validate a dashboard template payload without saving.',
    optional: true,
    parameters: {
      type: 'object',
      required: ['template'],
      properties: {
        template: { type: 'object' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: { template?: unknown } = {}) =>
      toToolResult(await runtime.templateValidate(params.template))
  });

  api.registerTool?.({
    name: 'plashboard_run_now',
    description: 'Run fill pipeline for a template immediately.',
    optional: true,
    parameters: {
      type: 'object',
      required: ['template_id'],
      properties: {
        template_id: { type: 'string' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: { template_id?: string } = {}) =>
      toToolResult(await runtime.runNow(params.template_id || ''))
  });

  api.registerTool?.({
    name: 'plashboard_status',
    description: 'Read current plashboard runtime status.',
    optional: true,
    execute: async () => toToolResult(await runtime.status())
  });

  api.registerTool?.({
    name: 'plashboard_display_profile_set',
    description: 'Update display profile for layout budget enforcement.',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        width_px: { type: 'number' },
        height_px: { type: 'number' },
        safe_top_px: { type: 'number' },
        safe_bottom_px: { type: 'number' },
        safe_side_px: { type: 'number' },
        layout_safety_margin_px: { type: 'number' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: Partial<DisplayProfile> = {}) =>
      toToolResult(await runtime.displayProfileSet(params))
  });

  api.registerCommand?.({
    name: 'plashboard',
    description: 'Plashboard admin command wrapper for common runtime operations.',
    acceptsArgs: true,
    handler: async (ctx: { args?: string }) => {
      const args = asString(ctx.args).split(/\s+/).filter(Boolean);
      const [cmd, ...rest] = args;

      if (cmd === 'expose-guide') {
        const localUrl = rest.find((token) => token.startsWith('http://') || token.startsWith('https://'));
        const portToken = rest.find((token) => /^[0-9]+$/.test(token));
        return toCommandResult(
          await buildExposureGuide(config, {
            local_url: localUrl,
            tailscale_https_port: portToken ? Number(portToken) : undefined
          })
        );
      }
      if (cmd === 'expose-check') {
        const localUrl = rest.find((token) => token.startsWith('http://') || token.startsWith('https://'));
        const portToken = rest.find((token) => /^[0-9]+$/.test(token));
        return toCommandResult(
          await runExposureCheck(config, {
            local_url: localUrl,
            tailscale_https_port: portToken ? Number(portToken) : undefined
          })
        );
      }
      if (cmd === 'setup') {
        const mode = asString(rest[0]).toLowerCase();
        const fillProvider = mode === 'command' || mode === 'mock' || mode === 'openclaw' ? mode : undefined;
        const fillCommand = fillProvider === 'command' ? rest.slice(1).join(' ').trim() || undefined : undefined;
        const fillAgentId = fillProvider === 'openclaw' ? (rest[1] || '').trim() || undefined : undefined;
        return toCommandResult(
          await runSetup(api, config, {
            fill_provider: fillProvider,
            fill_command: fillCommand,
            openclaw_fill_agent_id: fillAgentId
          })
        );
      }
      if (cmd === 'init') return toCommandResult(await runtime.init());
      if (cmd === 'status') return toCommandResult(await runtime.status());
      if (cmd === 'list') return toCommandResult(await runtime.templateList());
      if (cmd === 'activate') return toCommandResult(await runtime.templateActivate(rest[0] || ''));
      if (cmd === 'delete') return toCommandResult(await runtime.templateDelete(rest[0] || ''));
      if (cmd === 'copy') {
        return toCommandResult(
          await runtime.templateCopy(rest[0] || '', rest[1] || '', rest[2] || undefined, rest[3] === 'activate')
        );
      }
      if (cmd === 'run') return toCommandResult(await runtime.runNow(rest[0] || ''));
      if (cmd === 'set-display') {
        const input = asObject({
          width_px: rest[0] ? Number(rest[0]) : undefined,
          height_px: rest[1] ? Number(rest[1]) : undefined,
          safe_top_px: rest[2] ? Number(rest[2]) : undefined,
          safe_bottom_px: rest[3] ? Number(rest[3]) : undefined
        });
        return toCommandResult(await runtime.displayProfileSet(input as Partial<DisplayProfile>));
      }

      return toCommandResult({
        ok: false,
        errors: [
          'unknown command. supported: setup [openclaw [agent_id]|mock|command <fill_command>], expose-guide [local_url] [https_port], expose-check [local_url] [https_port], init, status, list, activate <id>, delete <id>, copy <src> <new-id> [new-name] [activate], run <id>, set-display <width> <height> <top> <bottom>'
        ]
      });
    }
  });
}
