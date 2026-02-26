import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DashboardTemplate, PlashboardConfig, PlashboardState, RunArtifact } from './types.js';
import { atomicWriteJson, ensureDir, readJsonFile } from './utils.js';

function emptyState(): PlashboardState {
  return {
    version: 1,
    active_template_id: null,
    template_runs: {}
  };
}

export class Paths {
  readonly dataDir: string;
  readonly statePath: string;
  readonly templatesDir: string;
  readonly runsDir: string;
  readonly renderedDir: string;
  readonly liveDashboardPath: string;

  constructor(config: PlashboardConfig) {
    this.dataDir = config.data_dir;
    this.statePath = join(this.dataDir, 'state.json');
    this.templatesDir = join(this.dataDir, 'templates');
    this.runsDir = join(this.dataDir, 'runs');
    this.renderedDir = join(this.dataDir, 'rendered');
    this.liveDashboardPath = config.dashboard_output_path;
  }

  async ensure(): Promise<void> {
    await Promise.all([
      ensureDir(this.dataDir),
      ensureDir(this.templatesDir),
      ensureDir(this.runsDir),
      ensureDir(this.renderedDir)
    ]);
  }
}

export class StateStore {
  constructor(private readonly paths: Paths) {}

  async load(): Promise<PlashboardState> {
    const value = await readJsonFile<PlashboardState>(this.paths.statePath);
    if (!value) {
      return emptyState();
    }
    return {
      version: 1,
      active_template_id: value.active_template_id ?? null,
      template_runs: value.template_runs ?? {},
      display_profile: value.display_profile
    };
  }

  async save(state: PlashboardState): Promise<void> {
    await atomicWriteJson(this.paths.statePath, state);
  }
}

export class TemplateStore {
  constructor(private readonly paths: Paths) {}

  pathForId(templateId: string): string {
    return join(this.paths.templatesDir, `${templateId}.json`);
  }

  async list(): Promise<DashboardTemplate[]> {
    await ensureDir(this.paths.templatesDir);
    const entries = await readdir(this.paths.templatesDir, { withFileTypes: true });
    const templates: DashboardTemplate[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = join(this.paths.templatesDir, entry.name);
      const loaded = await readJsonFile<DashboardTemplate>(fullPath);
      if (!loaded) continue;
      templates.push(loaded);
    }

    templates.sort((a, b) => a.id.localeCompare(b.id));
    return templates;
  }

  async get(templateId: string): Promise<DashboardTemplate | null> {
    return readJsonFile<DashboardTemplate>(this.pathForId(templateId));
  }

  async upsert(template: DashboardTemplate): Promise<void> {
    await atomicWriteJson(this.pathForId(template.id), template);
  }

  async remove(templateId: string): Promise<void> {
    await rm(this.pathForId(templateId), { force: true });
  }
}

export class RunStore {
  constructor(private readonly paths: Paths) {}

  async write(templateId: string, artifact: RunArtifact): Promise<string> {
    const safeTimestamp = artifact.started_at.replaceAll(':', '-');
    const dir = join(this.paths.runsDir, templateId);
    await ensureDir(dir);
    const filePath = join(dir, `${safeTimestamp}.json`);
    await atomicWriteJson(filePath, artifact);
    return filePath;
  }

  async latestByTemplate(templateId: string, limit = 10): Promise<RunArtifact[]> {
    const dir = join(this.paths.runsDir, templateId);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(dir, entry.name))
      .sort((a, b) => basename(b).localeCompare(basename(a)))
      .slice(0, limit);

    const output: RunArtifact[] = [];
    for (const file of files) {
      const loaded = await readJsonFile<RunArtifact>(file);
      if (loaded) output.push(loaded);
    }
    return output;
  }
}
