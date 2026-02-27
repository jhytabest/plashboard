import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DisplayProfile, PlashboardConfig } from './types.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WRITER_PATH = join(THIS_DIR, '..', 'scripts', 'dashboard_write.py');

function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  }
  return fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveDisplayProfile(raw: unknown): DisplayProfile {
  const data = asObject(raw);
  return {
    width_px: Math.max(320, Math.floor(asNumber(data.width_px, 1920))),
    height_px: Math.max(240, Math.floor(asNumber(data.height_px, 1080))),
    safe_top_px: Math.max(0, Math.floor(asNumber(data.safe_top_px, 96))),
    safe_bottom_px: Math.max(0, Math.floor(asNumber(data.safe_bottom_px, 106))),
    safe_side_px: Math.max(0, Math.floor(asNumber(data.safe_side_px, 28))),
    layout_safety_margin_px: Math.max(0, Math.floor(asNumber(data.layout_safety_margin_px, 24)))
  };
}

export function resolveConfig(api: unknown): PlashboardConfig {
  const apiObj = asObject(api);
  const pluginConfig = asObject(
    (apiObj.pluginConfig as unknown)
      ?? asObject(asObject(asObject(apiObj.config).plugins).entries).plashboard
  );
  const raw = asObject(pluginConfig.config ?? pluginConfig);

  const dataDir = asString(raw.data_dir, '/var/lib/openclaw/plash-data');
  const outputPath = asString(raw.dashboard_output_path, join(dataDir, 'dashboard.json'));
  const fillProviderRaw = asString(raw.fill_provider, 'openclaw');
  const fillProvider = fillProviderRaw === 'command'
    ? 'command'
    : fillProviderRaw === 'mock'
      ? 'mock'
      : 'openclaw';

  return {
    data_dir: dataDir,
    timezone: asString(raw.timezone, hostTimezone()),
    scheduler_tick_seconds: Math.max(5, Math.floor(asNumber(raw.scheduler_tick_seconds, 30))),
    max_parallel_runs: Math.max(1, Math.floor(asNumber(raw.max_parallel_runs, 1))),
    default_retry_count: Math.max(0, Math.floor(asNumber(raw.default_retry_count, 1))),
    retry_backoff_seconds: Math.max(1, Math.floor(asNumber(raw.retry_backoff_seconds, 20))),
    session_timeout_seconds: Math.max(10, Math.floor(asNumber(raw.session_timeout_seconds, 90))),
    auto_seed_template: asBoolean(raw.auto_seed_template, true),
    fill_provider: fillProvider,
    fill_command: typeof raw.fill_command === 'string' ? raw.fill_command : undefined,
    openclaw_fill_agent_id: asString(raw.openclaw_fill_agent_id, 'main'),
    python_bin: asString(raw.python_bin, 'python3'),
    writer_script_path: asString(raw.writer_script_path, DEFAULT_WRITER_PATH),
    dashboard_output_path: outputPath,
    layout_overflow_tolerance_px: Math.max(0, Math.floor(asNumber(raw.layout_overflow_tolerance_px, 40))),
    display_profile: resolveDisplayProfile(raw.display_profile),
    model_defaults: asObject(raw.model_defaults) as PlashboardConfig['model_defaults']
  };
}
