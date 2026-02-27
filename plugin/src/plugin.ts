import { constants as fsConstants } from 'node:fs';
import { access, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DisplayProfile, ToolResponse } from './types.js';
import { resolveConfig } from './config.js';
import { PlashboardRuntime } from './runtime.js';
import {
  createRuntimeCommandRunner,
  runCommand,
  type CommandRunner,
  type RuntimeCommandWithTimeout
} from './command-runner.js';

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
      runCommandWithTimeout?: RuntimeCommandWithTimeout;
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
  allow_command_fill?: boolean;
  fill_command?: string;
  openclaw_fill_agent_id?: string;
  auto_seed_template?: boolean;
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

type QuickstartParams = {
  description?: string;
  template_id?: string;
  template_name?: string;
  every_minutes?: number;
  activate?: boolean;
  run_now?: boolean;
};

type ExposureParams = {
  local_url?: string;
  tailscale_https_port?: number;
  dashboard_output_path?: string;
};

type WebGuideParams = {
  local_url?: string;
  repo_dir?: string;
};

type DoctorParams = ExposureParams & {
  repo_dir?: string;
};

type PermissionsFixParams = {
  dashboard_output_path?: string;
};

type OnboardParams = DoctorParams & QuickstartParams & {
  force_quickstart?: boolean;
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

function parseJsonLoose(input: string): unknown | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const starts = ['{', '['];
  for (const opener of starts) {
    const start = trimmed.indexOf(opener);
    if (start < 0) continue;
    const closer = opener === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(closer);
    if (end <= start) continue;
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return undefined;
}

function octalMode(value: number | undefined): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  return `0${(value! & 0o777).toString(8).padStart(3, '0')}`;
}

async function listOpenClawAgentIds(commandRunner: CommandRunner | null): Promise<{
  ok: boolean;
  ids: string[];
  error?: string;
}> {
  const result = await runCommand(
    commandRunner,
    ['openclaw', 'agents', 'list', '--json'],
    12_000,
    'openclaw agents list'
  );
  if (!result.ok) {
    return {
      ok: false,
      ids: [],
      error: result.error || result.stderr || `exit ${String(result.code)}`
    };
  }

  const parsed = parseJsonLoose(result.stdout);
  if (!Array.isArray(parsed)) {
    return { ok: false, ids: [], error: 'unable to parse openclaw agents list output' };
  }

  const ids = parsed
    .map((entry) => asObject(entry))
    .map((entry) => asString(entry.id))
    .filter(Boolean);
  return { ok: true, ids };
}

async function checkWriterPreflight(
  resolvedConfig: ReturnType<typeof resolveConfig>,
  commandRunner: CommandRunner | null
): Promise<{
  ready: boolean;
  errors: string[];
  python_version?: string;
}> {
  const errors: string[] = [];

  try {
    await access(resolvedConfig.writer_script_path, fsConstants.R_OK);
  } catch {
    errors.push(`writer script is not readable: ${resolvedConfig.writer_script_path}`);
  }

  const version = await runCommand(
    commandRunner,
    [resolvedConfig.python_bin, '--version'],
    8_000,
    'python runtime preflight'
  );
  if (!version.ok) {
    errors.push(`python runtime check failed: ${version.error || version.stderr || `exit ${String(version.code)}`}`);
  }

  return {
    ready: errors.length === 0,
    errors,
    python_version: version.ok ? (version.stdout || version.stderr) : undefined
  };
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
        `curl -I ${localUrl}`,
        `curl -I ${localUrl.replace(/\/$/, '')}/data/dashboard.json`
      ],
      notes: [
        'plashboard only writes dashboard JSON; your local UI/server must serve it.',
        'the tailscale mapping reuses your existing tailnet identity.',
        'choose a port not already used by another tailscale serve mapping.'
      ]
    }
  } satisfies ToolResponse<Record<string, unknown>>;
}

function deriveRepoDir(raw?: string): string {
  const value = (raw || '').trim();
  return value || '/opt/plashboard';
}

async function buildWebGuide(resolvedConfig: ReturnType<typeof resolveConfig>, params: WebGuideParams = {}) {
  const localUrl = normalizeLocalUrl(params.local_url);
  const repoDir = deriveRepoDir(params.repo_dir);
  const dashboardPath = resolvedConfig.dashboard_output_path;

  return {
    ok: true,
    errors: [],
    data: {
      local_url: localUrl,
      repo_dir: repoDir,
      dashboard_output_path: dashboardPath,
      commands: [
        `git clone https://github.com/jhytabest/plashboard.git ${repoDir} || true`,
        `git -C ${repoDir} pull --ff-only`,
        `docker compose -f ${repoDir}/docker-compose.yml up -d`,
        `docker ps --format "{{.Names}} {{.Ports}}" | grep -E "plash-web|18888"`,
        `curl -I ${localUrl}`,
        `curl -I ${localUrl}/healthz`
      ],
      notes: [
        'Plashboard writes dashboard JSON; a local web server must serve the UI and /data/dashboard.json.',
        'The bundled docker-compose stack exposes nginx at 127.0.0.1:18888 by default.',
        'If you host UI differently, update local_url in expose-check/expose-guide.'
      ]
    }
  } satisfies ToolResponse<Record<string, unknown>>;
}

async function runExposureCheck(
  resolvedConfig: ReturnType<typeof resolveConfig>,
  commandRunner: CommandRunner | null,
  params: ExposureParams = {}
) {
  const localUrl = normalizeLocalUrl(params.local_url);
  const httpsPort = normalizePort(asNumber(params.tailscale_https_port), 8444);
  const dashboardPath = (params.dashboard_output_path || resolvedConfig.dashboard_output_path).trim();
  const dataDirPath = dirname(dashboardPath);
  const errors: string[] = [];

  let dashboardExists = false;
  let dashboardSizeBytes: number | undefined;
  let dashboardMtimeIso: string | undefined;
  let dataDirMode: number | undefined;

  try {
    await access(dashboardPath, fsConstants.R_OK);
    const info = await stat(dashboardPath);
    dashboardExists = true;
    dashboardSizeBytes = info.size;
    dashboardMtimeIso = info.mtime.toISOString();
  } catch {
    errors.push(`dashboard file is not readable: ${dashboardPath}`);
  }
  try {
    const dirInfo = await stat(dataDirPath);
    dataDirMode = dirInfo.mode & 0o777;
  } catch {
    // ignore
  }

  let localUrlOk = false;
  let localStatusCode: number | undefined;
  let localError: string | undefined;
  const localDashboardUrl = new URL('/data/dashboard.json', localUrl).toString();
  let localDashboardOk = false;
  let localDashboardStatusCode: number | undefined;
  let localDashboardError: string | undefined;

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

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(localDashboardUrl, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timer);
    localDashboardStatusCode = response.status;
    localDashboardOk = response.status >= 200 && response.status < 300;
    if (!localDashboardOk) {
      errors.push(`dashboard JSON URL returned status ${response.status}: ${localDashboardUrl}`);
      if (response.status === 403) {
        errors.push(`dashboard JSON access denied; check directory permissions for ${dataDirPath}`);
      }
    }
  } catch (error) {
    localDashboardError = asErrorMessage(error);
    errors.push(`dashboard JSON URL is not reachable: ${localDashboardUrl} (${localDashboardError})`);
  }

  const tailscale = await runCommand(commandRunner, ['tailscale', 'serve', 'status'], 8000, 'tailscale serve status');
  const tailscaleOutput = `${tailscale.stdout}\n${tailscale.stderr}`.trim();
  let tailscalePortConfigured = false;
  let tailscaleTargetConfigured = false;

  if (!tailscale.ok) {
    errors.push(`tailscale serve status failed: ${tailscale.error || tailscale.stderr || `exit ${tailscale.code}`}`);
  } else {
    tailscalePortConfigured = tailscaleOutput.includes(`:${httpsPort}`);
    tailscaleTargetConfigured = tailscaleOutput.includes(`proxy ${localUrl.replace(/\/$/, '')}`);
    if (!tailscalePortConfigured) {
      errors.push(`tailscale serve has no mapping for https port ${httpsPort}`);
    }
    if (!tailscaleTargetConfigured) {
      errors.push(`tailscale serve mapping does not target ${localUrl}`);
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
      local_dashboard_url: localDashboardUrl,
      local_dashboard_ok: localDashboardOk,
      local_dashboard_status_code: localDashboardStatusCode,
      local_dashboard_error: localDashboardError,
      data_dir_path: dataDirPath,
      data_dir_mode: dataDirMode,
      data_dir_mode_octal: octalMode(dataDirMode),
      tailscale_https_port: httpsPort,
      tailscale_status_ok: tailscale.ok,
      tailscale_port_configured: tailscalePortConfigured,
      tailscale_target_configured: tailscaleTargetConfigured,
      tailscale_status_excerpt: tailscaleOutput.slice(0, 1200)
    }
  } satisfies ToolResponse<Record<string, unknown>>;
}

async function runSetup(
  api: UnknownApi,
  resolvedConfig: ReturnType<typeof resolveConfig>,
  commandRunner: CommandRunner | null,
  params: SetupParams = {}
) {
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
  const selectedAutoSeed = (
    typeof params.auto_seed_template === 'boolean'
      ? params.auto_seed_template
      : typeof currentPluginConfig.auto_seed_template === 'boolean'
        ? currentPluginConfig.auto_seed_template
        : resolvedConfig.auto_seed_template
  );
  const selectedAllowCommandFill = (
    typeof params.allow_command_fill === 'boolean'
      ? params.allow_command_fill
      : typeof currentPluginConfig.allow_command_fill === 'boolean'
        ? Boolean(currentPluginConfig.allow_command_fill)
        : resolvedConfig.allow_command_fill
  );
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
  if (selectedProvider === 'command' && !selectedAllowCommandFill) {
    return {
      ok: false,
      errors: ['fill_provider=command requires allow_command_fill=true']
    } satisfies ToolResponse<Record<string, unknown>>;
  }
  if (selectedProvider === 'command' && !commandRunner) {
    return {
      ok: false,
      errors: ['fill_provider=command requires runtime command runner support in this OpenClaw build']
    } satisfies ToolResponse<Record<string, unknown>>;
  }
  if (selectedProvider === 'openclaw' && !selectedAgentId) {
    return {
      ok: false,
      errors: ['fill_provider=openclaw requires openclaw_fill_agent_id']
    } satisfies ToolResponse<Record<string, unknown>>;
  }
  if (selectedProvider === 'openclaw') {
    const agents = await listOpenClawAgentIds(commandRunner);
    if (!agents.ok) {
      return {
        ok: false,
        errors: [`unable to validate openclaw_fill_agent_id: ${agents.error || 'unknown error'}`]
      } satisfies ToolResponse<Record<string, unknown>>;
    }
    if (!agents.ids.includes(selectedAgentId)) {
      return {
        ok: false,
        errors: [
          `openclaw_fill_agent_id not found: ${selectedAgentId}`,
          `available agent ids: ${agents.ids.join(', ') || '(none)'}`
        ]
      } satisfies ToolResponse<Record<string, unknown>>;
    }
  }

  const preflight = await checkWriterPreflight(resolvedConfig, commandRunner);
  if (!preflight.ready) {
    return {
      ok: false,
      errors: preflight.errors
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
    allow_command_fill: selectedAllowCommandFill,
    auto_seed_template: selectedAutoSeed,
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
      allow_command_fill: selectedAllowCommandFill,
      fill_command: selectedProvider === 'command' ? selectedCommand : undefined,
      openclaw_fill_agent_id: selectedProvider === 'openclaw' ? selectedAgentId : undefined,
      auto_seed_template: selectedAutoSeed,
      data_dir: nextPluginConfig.data_dir,
      scheduler_tick_seconds: nextPluginConfig.scheduler_tick_seconds,
      session_timeout_seconds: nextPluginConfig.session_timeout_seconds,
      display_profile: displayProfile,
      python_version: preflight.python_version,
      next_steps: [
        'restart OpenClaw gateway',
        'run /plashboard init'
      ]
    }
  } satisfies ToolResponse<Record<string, unknown>>;
}

async function runPermissionsFix(
  resolvedConfig: ReturnType<typeof resolveConfig>,
  params: PermissionsFixParams = {}
): Promise<ToolResponse<Record<string, unknown>>> {
  const dashboardPath = (params.dashboard_output_path || resolvedConfig.dashboard_output_path).trim();
  const dataDirPath = dirname(dashboardPath);
  const errors: string[] = [];

  let beforeDataDirMode: number | undefined;
  let beforeDashboardMode: number | undefined;
  let afterDataDirMode: number | undefined;
  let afterDashboardMode: number | undefined;

  try {
    beforeDataDirMode = (await stat(dataDirPath)).mode & 0o777;
  } catch (error) {
    return {
      ok: false,
      errors: [`data directory is missing or unreadable: ${dataDirPath} (${asErrorMessage(error)})`]
    };
  }

  try {
    beforeDashboardMode = (await stat(dashboardPath)).mode & 0o777;
  } catch {
    // dashboard file may not exist yet
  }

  try {
    await chmod(dataDirPath, 0o755);
    afterDataDirMode = (await stat(dataDirPath)).mode & 0o777;
  } catch (error) {
    errors.push(`failed to set directory mode for ${dataDirPath}: ${asErrorMessage(error)}`);
  }

  try {
    await access(dashboardPath, fsConstants.F_OK);
    await chmod(dashboardPath, 0o644);
    afterDashboardMode = (await stat(dashboardPath)).mode & 0o777;
  } catch {
    // dashboard file may not exist yet
  }

  return {
    ok: errors.length === 0,
    errors,
    data: {
      dashboard_output_path: dashboardPath,
      data_dir_path: dataDirPath,
      before_data_dir_mode_octal: octalMode(beforeDataDirMode),
      after_data_dir_mode_octal: octalMode(afterDataDirMode),
      before_dashboard_mode_octal: octalMode(beforeDashboardMode),
      after_dashboard_mode_octal: octalMode(afterDashboardMode),
      note: 'This is an explicit compatibility fix for dashboard web servers that read through bind mounts.'
    }
  };
}

async function runQuickstart(
  runtime: PlashboardRuntime,
  resolvedConfig: ReturnType<typeof resolveConfig>,
  commandRunner: CommandRunner | null,
  params: QuickstartParams = {}
): Promise<ToolResponse<Record<string, unknown>>> {
  const quickstart = await runtime.quickstart(params);
  const exposure = await runExposureCheck(resolvedConfig, commandRunner, {});
  const guide = await buildExposureGuide(resolvedConfig, {});
  const webGuide = await buildWebGuide(resolvedConfig, {});

  const warnings: string[] = [];
  if (!exposure.ok) {
    warnings.push(...exposure.errors);
  }

  return {
    ok: quickstart.ok,
    errors: quickstart.errors,
    data: {
      ...(quickstart.data || {}),
      postcheck: {
        local_url: exposure.data?.local_url,
        local_url_ok: exposure.data?.local_url_ok,
        tailscale_port_configured: exposure.data?.tailscale_port_configured,
        dashboard_exists: exposure.data?.dashboard_exists
      },
      warnings,
      next_steps: warnings.length
        ? [
          'run /plashboard web-guide and execute its commands',
          'run /plashboard expose-guide and apply tailscale mapping',
          'run /plashboard doctor'
        ]
        : [
          'dashboard generation is working',
          'run /plashboard doctor for full readiness check'
        ],
      exposure_guide: guide.data,
      web_guide: webGuide.data
    }
  };
}

async function runDoctor(
  runtime: PlashboardRuntime,
  resolvedConfig: ReturnType<typeof resolveConfig>,
  commandRunner: CommandRunner | null,
  params: DoctorParams = {}
): Promise<ToolResponse<Record<string, unknown>>> {
  const status = await runtime.status();
  const templateList = await runtime.templateList();
  const exposure = await runExposureCheck(resolvedConfig, commandRunner, params);
  const exposureGuide = await buildExposureGuide(resolvedConfig, params);
  const webGuide = await buildWebGuide(resolvedConfig, params);
  const writerPreflight = await checkWriterPreflight(resolvedConfig, commandRunner);

  const issues: string[] = [];
  const warnings: string[] = [];
  const statusData = status.data;
  const templateCount = Number(statusData?.template_count ?? 0);
  const activeTemplateId = statusData?.active_template_id || null;
  const runtimeCommandRunnerAvailable = Boolean(statusData?.capabilities?.runtime_command_runner_available);
  const commandFillAllowed = Boolean(statusData?.capabilities?.command_fill_allowed);

  let fillProviderReady = resolvedConfig.fill_provider === 'mock'
    ? true
    : resolvedConfig.fill_provider === 'openclaw'
      ? runtimeCommandRunnerAvailable && Boolean((resolvedConfig.openclaw_fill_agent_id || '').trim())
      : runtimeCommandRunnerAvailable && commandFillAllowed && Boolean((resolvedConfig.fill_command || '').trim());

  let fillAgentIds: string[] = [];
  if (resolvedConfig.fill_provider === 'openclaw') {
    const agents = await listOpenClawAgentIds(commandRunner);
    if (!agents.ok) {
      fillProviderReady = false;
      issues.push(`unable to validate openclaw_fill_agent_id: ${agents.error || 'unknown error'}`);
    } else {
      fillAgentIds = agents.ids;
      if (!agents.ids.includes(resolvedConfig.openclaw_fill_agent_id || 'main')) {
        fillProviderReady = false;
        issues.push(`openclaw_fill_agent_id not found: ${resolvedConfig.openclaw_fill_agent_id || 'main'}`);
      }
      if ((resolvedConfig.openclaw_fill_agent_id || 'main').trim() === 'main') {
        warnings.push('openclaw_fill_agent_id=main can cause session lock contention; prefer a dedicated fill agent.');
      }
    }
  }

  const writerRunnerReady = writerPreflight.ready;

  if (!status.ok) issues.push(...status.errors);
  if (!templateList.ok) issues.push(...templateList.errors);
  if (!fillProviderReady) {
    if (resolvedConfig.fill_provider === 'command' && !commandFillAllowed) {
      issues.push('fill_provider=command is disabled; set allow_command_fill=true');
    } else {
      issues.push(`fill provider "${resolvedConfig.fill_provider}" is not ready`);
    }
  }
  if (!writerRunnerReady) {
    issues.push(...writerPreflight.errors);
  }
  if (templateCount === 0) issues.push('no templates exist; run /plashboard quickstart "<description>"');
  if (!activeTemplateId) issues.push('no active template; activate one with /plashboard activate <template-id>');
  if (exposure.data?.dashboard_exists !== true) {
    issues.push(`dashboard output missing at ${resolvedConfig.dashboard_output_path}`);
  }
  if (exposure.data?.local_url_ok !== true) {
    issues.push(`local dashboard server is not reachable at ${String(exposure.data?.local_url || 'http://127.0.0.1:18888')}`);
  }
  if (exposure.data?.local_dashboard_ok !== true) {
    issues.push(`dashboard JSON endpoint is not reachable at ${String(exposure.data?.local_dashboard_url || `${String(exposure.data?.local_url || 'http://127.0.0.1:18888')}/data/dashboard.json`)}`);
  }
  if (exposure.data?.tailscale_status_ok !== true) {
    issues.push('tailscale serve status failed');
  } else if (exposure.data?.tailscale_port_configured !== true) {
    issues.push(`tailscale serve mapping missing for port ${String(exposure.data?.tailscale_https_port || 8444)}`);
  } else if (exposure.data?.tailscale_target_configured !== true) {
    issues.push(`tailscale serve mapping does not target ${String(exposure.data?.local_url || 'http://127.0.0.1:18888')}`);
  }
  if (Number(exposure.data?.local_dashboard_status_code) === 403) {
    warnings.push(`dashboard JSON returned 403; run /plashboard fix-permissions to apply compatible read modes.`);
  }

  const templates = Array.isArray(templateList.data?.templates) ? templateList.data?.templates : [];
  const activeTemplate = templates?.find((entry) => asString(entry.id) === activeTemplateId);
  const everyMinutes = asNumber(asObject(activeTemplate?.schedule).every_minutes);
  const mtimeIso = asString(exposure.data?.dashboard_mtime_utc);
  if (everyMinutes && mtimeIso) {
    const ageMs = Date.now() - Date.parse(mtimeIso);
    const maxAgeMs = Math.max(everyMinutes * 2 * 60_000, 10 * 60_000);
    if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
      issues.push(`dashboard appears stale: last update ${mtimeIso} (age ${Math.floor(ageMs / 60_000)}m)`);
    }
  }

  if (!runtimeCommandRunnerAvailable) {
    warnings.push('runtime command runner unavailable; fill/publish checks may fail in this OpenClaw build.');
  }
  const dataDirMode = asNumber(exposure.data?.data_dir_mode);
  if (typeof dataDirMode === 'number' && (dataDirMode & 0o005) === 0) {
    warnings.push(`data directory mode ${String(exposure.data?.data_dir_mode_octal || '')} may block containerized web readers.`);
  }

  const ready = issues.length === 0;
  return {
    ok: ready,
    errors: issues,
    data: {
      ready,
      fill_provider_ready: fillProviderReady,
      writer_runner_ready: writerRunnerReady,
      warnings,
      writer_preflight: {
        ready: writerPreflight.ready,
        python_version: writerPreflight.python_version
      },
      fill_agent_ids: fillAgentIds,
      status: statusData,
      exposure: exposure.data,
      exposure_guide: exposureGuide.data,
      web_guide: webGuide.data,
      next_steps: ready
        ? ['dashboard runtime + web exposure look healthy']
        : [
          'run /plashboard quickstart "<description>" if no templates exist',
          'run /plashboard web-guide and start local UI server',
          'run /plashboard expose-guide and apply tailscale mapping',
          'run /plashboard fix-permissions if dashboard JSON returns 403',
          're-run /plashboard doctor'
        ]
    }
  };
}

async function runOnboard(
  runtime: PlashboardRuntime,
  resolvedConfig: ReturnType<typeof resolveConfig>,
  commandRunner: CommandRunner | null,
  params: OnboardParams = {}
): Promise<ToolResponse<Record<string, unknown>>> {
  const initResult = await runtime.init();
  if (!initResult.ok) return initResult;

  const beforeStatus = await runtime.status();
  const beforeTemplateCount = Number(beforeStatus.data?.template_count ?? 0);
  const shouldQuickstart = params.force_quickstart === true || beforeTemplateCount === 0;

  let quickstartResult: ToolResponse<Record<string, unknown>> | null = null;
  if (shouldQuickstart) {
    quickstartResult = await runQuickstart(runtime, resolvedConfig, commandRunner, {
      description: params.description,
      template_id: params.template_id,
      template_name: params.template_name,
      every_minutes: params.every_minutes,
      activate: params.activate,
      run_now: params.run_now
    });
  }

  const doctorResult = await runDoctor(runtime, resolvedConfig, commandRunner, {
    local_url: params.local_url,
    tailscale_https_port: params.tailscale_https_port,
    dashboard_output_path: params.dashboard_output_path,
    repo_dir: params.repo_dir
  });

  return {
    ok: doctorResult.ok,
    errors: doctorResult.errors,
    data: {
      workflow: 'onboard',
      init: initResult.data,
      quickstart_ran: shouldQuickstart,
      quickstart: quickstartResult?.data,
      doctor: doctorResult.data,
      next_steps: doctorResult.data?.next_steps ?? []
    }
  };
}

export function registerPlashboardPlugin(api: UnknownApi): void {
  const config = resolveConfig(api);
  const commandRunner = createRuntimeCommandRunner(api.runtime?.system?.runCommandWithTimeout);
  const runtime = new PlashboardRuntime(config, {
    info: (...args) => api.logger?.info?.(...args),
    warn: (...args) => api.logger?.warn?.(...args),
    error: (...args) => api.logger?.error?.(...args)
  }, {
    commandRunner
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
    name: 'plashboard_onboard',
    description: 'Run complete onboarding flow: init, first template (if needed), and readiness doctor.',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        template_id: { type: 'string' },
        template_name: { type: 'string' },
        every_minutes: { type: 'number' },
        activate: { type: 'boolean' },
        run_now: { type: 'boolean' },
        local_url: { type: 'string' },
        tailscale_https_port: { type: 'number' },
        dashboard_output_path: { type: 'string' },
        repo_dir: { type: 'string' },
        force_quickstart: { type: 'boolean' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: OnboardParams = {}) =>
      toToolResult(await runOnboard(runtime, config, commandRunner, params))
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
      toToolResult(await runExposureCheck(config, commandRunner, params))
  });

  api.registerTool?.({
    name: 'plashboard_web_guide',
    description: 'Return exact commands to start the local plashboard web UI server.',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        local_url: { type: 'string' },
        repo_dir: { type: 'string' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: WebGuideParams = {}) =>
      toToolResult(await buildWebGuide(config, params))
  });

  api.registerTool?.({
    name: 'plashboard_doctor',
    description: 'Run full plashboard readiness checks (templates, local UI, and tailscale mapping).',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        local_url: { type: 'string' },
        tailscale_https_port: { type: 'number' },
        dashboard_output_path: { type: 'string' },
        repo_dir: { type: 'string' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: DoctorParams = {}) =>
      toToolResult(await runDoctor(runtime, config, commandRunner, params))
  });

  api.registerTool?.({
    name: 'plashboard_permissions_fix',
    description: 'Apply compatibility file modes for dashboard web readers (explicit action).',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        dashboard_output_path: { type: 'string' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: PermissionsFixParams = {}) =>
      toToolResult(await runPermissionsFix(config, params))
  });

  api.registerTool?.({
    name: 'plashboard_setup',
    description: 'Bootstrap or update plashboard plugin configuration in openclaw.json.',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        fill_provider: { type: 'string', enum: ['mock', 'command', 'openclaw'] },
        allow_command_fill: { type: 'boolean' },
        fill_command: { type: 'string' },
        openclaw_fill_agent_id: { type: 'string' },
        auto_seed_template: { type: 'boolean' },
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
      toToolResult(await runSetup(api, config, commandRunner, params))
  });

  api.registerTool?.({
    name: 'plashboard_init',
    description: 'Initialize plashboard state directories and optional default template.',
    optional: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    execute: async () => toToolResult(await runtime.init())
  });

  api.registerTool?.({
    name: 'plashboard_quickstart',
    description: 'Create a first dashboard template from a short description, activate it, and run it once.',
    optional: true,
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        template_id: { type: 'string' },
        template_name: { type: 'string' },
        every_minutes: { type: 'number' },
        activate: { type: 'boolean' },
        run_now: { type: 'boolean' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: unknown, params: QuickstartParams = {}) =>
      toToolResult(await runQuickstart(runtime, config, commandRunner, params))
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
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
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
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
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
          await runExposureCheck(config, commandRunner, {
            local_url: localUrl,
            tailscale_https_port: portToken ? Number(portToken) : undefined
          })
        );
      }
      if (cmd === 'web-guide') {
        const localUrl = rest.find((token) => token.startsWith('http://') || token.startsWith('https://'));
        const repoDir = rest.find((token) => token.startsWith('/'));
        return toCommandResult(
          await buildWebGuide(config, {
            local_url: localUrl,
            repo_dir: repoDir
          })
        );
      }
      if (cmd === 'doctor') {
        const localUrl = rest.find((token) => token.startsWith('http://') || token.startsWith('https://'));
        const portToken = rest.find((token) => /^[0-9]+$/.test(token));
        const repoDir = rest.find((token) => token.startsWith('/'));
        return toCommandResult(
          await runDoctor(runtime, config, commandRunner, {
            local_url: localUrl,
            tailscale_https_port: portToken ? Number(portToken) : undefined,
            repo_dir: repoDir
          })
        );
      }
      if (cmd === 'fix-permissions') {
        return toCommandResult(
          await runPermissionsFix(config, {
            dashboard_output_path: rest[0]
          })
        );
      }
      if (cmd === 'onboard') {
        const localUrl = rest.find((token) => token.startsWith('http://') || token.startsWith('https://'));
        const portToken = rest.find((token) => /^[0-9]+$/.test(token));
        const repoDir = rest.find((token) => token.startsWith('/'));
        const descriptionTokens = rest.filter((token) => token !== localUrl && token !== portToken && token !== repoDir);
        const description = descriptionTokens.join(' ').trim() || undefined;
        return toCommandResult(
          await runOnboard(runtime, config, commandRunner, {
            description,
            local_url: localUrl,
            tailscale_https_port: portToken ? Number(portToken) : undefined,
            repo_dir: repoDir
          })
        );
      }
      if (cmd === 'setup') {
        const mode = asString(rest[0]).toLowerCase();
        const fillProvider = mode === 'command' || mode === 'mock' || mode === 'openclaw' ? mode : undefined;
        const fillCommand = fillProvider === 'command' ? rest.slice(1).join(' ').trim() || undefined : undefined;
        const fillAgentId = fillProvider === 'openclaw' ? (rest[1] || '').trim() || undefined : undefined;
        return toCommandResult(
          await runSetup(api, config, commandRunner, {
            fill_provider: fillProvider,
            allow_command_fill: fillProvider === 'command' ? true : undefined,
            fill_command: fillCommand,
            openclaw_fill_agent_id: fillAgentId
          })
        );
      }
      if (cmd === 'quickstart') {
        const description = rest.join(' ').trim() || undefined;
        return toCommandResult(await runQuickstart(runtime, config, commandRunner, { description }));
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
          'unknown command. supported: onboard <description> [local_url] [https_port] [repo_dir], setup [openclaw [agent_id]|mock|command <fill_command>], quickstart <description>, doctor [local_url] [https_port] [repo_dir], fix-permissions [dashboard_output_path], web-guide [local_url] [repo_dir], expose-guide [local_url] [https_port], expose-check [local_url] [https_port], init, status, list, activate <id>, delete <id>, copy <src> <new-id> [new-name] [activate], run <id>, set-display <width> <height> <top> <bottom>'
        ]
      });
    }
  });
}
