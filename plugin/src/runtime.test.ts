import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PlashboardRuntime } from './runtime.js';
import type { DashboardTemplate, PlashboardConfig } from './types.js';

function baseDashboard() {
  return {
    title: 'Dashboard',
    summary: 'old summary',
    ui: { timezone: 'Europe/Berlin' },
    sections: [
      {
        id: 'main',
        label: 'Main',
        cards: [
          {
            id: 'card-1',
            title: 'Card One',
            description: 'desc'
          }
        ]
      }
    ],
    alerts: []
  };
}

function template(id: string): DashboardTemplate {
  return {
    id,
    name: id,
    enabled: true,
    schedule: {
      mode: 'interval',
      every_minutes: 5,
      timezone: 'Europe/Berlin'
    },
    base_dashboard: baseDashboard(),
    fields: [
      {
        id: 'summary',
        pointer: '/summary',
        type: 'string',
        prompt: 'Write summary',
        required: true,
        constraints: { max_len: 200 }
      }
    ]
  };
}

async function setupRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'plashboard-test-'));
  const config: PlashboardConfig = {
    data_dir: root,
    timezone: 'Europe/Berlin',
    scheduler_tick_seconds: 30,
    max_parallel_runs: 1,
    default_retry_count: 0,
    retry_backoff_seconds: 1,
    session_timeout_seconds: 30,
    fill_provider: 'mock',
    fill_command: undefined,
    python_bin: 'python3',
    writer_script_path: join(process.cwd(), 'scripts', 'dashboard_write.py'),
    dashboard_output_path: join(root, 'dashboard.json'),
    layout_overflow_tolerance_px: 40,
    display_profile: {
      width_px: 1920,
      height_px: 1080,
      safe_top_px: 96,
      safe_bottom_px: 106,
      safe_side_px: 28,
      layout_safety_margin_px: 24
    },
    model_defaults: {}
  };

  const runtime = new PlashboardRuntime(config);
  await runtime.init();
  return { runtime, root, config };
}

describe('PlashboardRuntime', () => {
  it('creates template and runs pipeline with publish', async () => {
    const { runtime, root, config } = await setupRuntime();
    try {
      const created = await runtime.templateCreate(template('ops'));
      expect(created.ok).toBe(true);

      const run = await runtime.runNow('ops');
      expect(run.ok).toBe(true);
      expect(run.data?.published).toBe(true);

      const published = JSON.parse(await readFile(config.dashboard_output_path, 'utf8')) as Record<string, unknown>;
      expect(published.version).toBe('3.0');
      expect(typeof published.generated_at).toBe('string');
      expect(String(published.summary)).toContain('updated summary');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not publish when template is inactive', async () => {
    const { runtime, root, config } = await setupRuntime();
    try {
      expect((await runtime.templateCreate(template('one'))).ok).toBe(true);
      expect((await runtime.templateCreate(template('two'))).ok).toBe(true);
      expect((await runtime.templateActivate('one')).ok).toBe(true);
      expect((await runtime.runNow('one')).ok).toBe(true);

      const run = await runtime.runNow('two');
      expect(run.ok).toBe(true);
      expect(run.data?.published).toBe(false);

      const published = JSON.parse(await readFile(config.dashboard_output_path, 'utf8')) as Record<string, unknown>;
      expect(published).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects template with invalid field pointer', async () => {
    const { runtime, root } = await setupRuntime();
    try {
      const bad = template('bad');
      bad.fields[0].pointer = '/sections/0/cards/0/unknown';
      const result = await runtime.templateCreate(bad);
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toMatch(/pointer path not found|validation failed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies and deletes templates', async () => {
    const { runtime, root } = await setupRuntime();
    try {
      expect((await runtime.templateCreate(template('ops'))).ok).toBe(true);

      const copied = await runtime.templateCopy('ops', 'ops-copy', 'Ops Copy', true);
      expect(copied.ok).toBe(true);
      expect(copied.data?.template_id).toBe('ops-copy');
      expect(copied.data?.active_template_id).toBe('ops-copy');

      const listAfterCopy = await runtime.templateList();
      expect(listAfterCopy.ok).toBe(true);
      expect(listAfterCopy.data?.templates.map((entry) => entry.id)).toEqual(['ops', 'ops-copy']);

      const deleted = await runtime.templateDelete('ops-copy');
      expect(deleted.ok).toBe(true);
      expect(deleted.data?.deleted_template_id).toBe('ops-copy');

      const listAfterDelete = await runtime.templateList();
      expect(listAfterDelete.ok).toBe(true);
      expect(listAfterDelete.data?.templates.map((entry) => entry.id)).toEqual(['ops']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
