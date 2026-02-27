import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import type {
  DashboardTemplate,
  DisplayProfile,
  FillResponse,
  FillRunner,
  PlashboardConfig,
  PlashboardState,
  RunArtifact,
  RuntimeStatus,
  ToolResponse
} from './types.js';
import { Paths, RunStore, StateStore, TemplateStore } from './stores.js';
import { asErrorMessage, atomicWriteJson, deepClone, ensureDir, nowIso, sleep } from './utils.js';
import { collectCurrentValues, mergeTemplateValues, validateFieldPointers } from './merge.js';
import { validateFillShape, validateTemplateShape } from './schema-validation.js';
import { DashboardValidatorPublisher } from './publisher.js';
import { createFillRunner, type FillRunnerDeps } from './fill-runner.js';

interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

function resolveLastAttemptMs(state: PlashboardState, templateId: string): number | null {
  const runState = state.template_runs[templateId];
  if (!runState) return null;
  const candidates = [runState.last_attempt_at, runState.last_success_at]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));

  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function coerceTemplate(input: unknown): DashboardTemplate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('template must be an object');
  }
  return input as DashboardTemplate;
}

export class PlashboardRuntime {
  private readonly paths: Paths;
  private readonly stateStore: StateStore;
  private readonly templateStore: TemplateStore;
  private readonly runStore: RunStore;
  private readonly publisher: DashboardValidatorPublisher;
  private readonly fillRunner: FillRunner;

  private schedulerTimer: NodeJS.Timeout | null = null;
  private tickInProgress = false;
  private readonly runningTemplates = new Set<string>();
  private stateCache: PlashboardState | null = null;

  constructor(
    private readonly config: PlashboardConfig,
    private readonly logger: Logger = NOOP_LOGGER,
    fillRunnerDeps: FillRunnerDeps = {}
  ) {
    this.paths = new Paths(config);
    this.stateStore = new StateStore(this.paths);
    this.templateStore = new TemplateStore(this.paths);
    this.runStore = new RunStore(this.paths);
    this.publisher = new DashboardValidatorPublisher(config);
    this.fillRunner = createFillRunner(config, fillRunnerDeps);
  }

  async start(): Promise<void> {
    await this.init();
    if (this.schedulerTimer) return;

    const intervalMs = this.config.scheduler_tick_seconds * 1000;
    this.schedulerTimer = setInterval(() => {
      void this.tickScheduler();
    }, intervalMs);
    this.logger.info('plashboard scheduler started (tick=%ds)', this.config.scheduler_tick_seconds);

    void this.tickScheduler();
  }

  async stop(): Promise<void> {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  async init(): Promise<ToolResponse<Record<string, unknown>>> {
    await this.paths.ensure();
    await this.loadState();

    const templates = await this.templateStore.list();
    const state = await this.loadState();

    if (!state.display_profile) {
      state.display_profile = this.config.display_profile;
      await this.saveState(state);
    }

    if (!templates.length) {
      const seeded = await this.seedDefaultTemplate();
      if (seeded) {
        const next = await this.templateStore.list();
        if (!state.active_template_id && next.length) {
          state.active_template_id = next[0].id;
          await this.saveState(state);
        }
      }
    }

    return {
      ok: true,
      errors: [],
      data: {
        data_dir: this.paths.dataDir,
        dashboard_output_path: this.paths.liveDashboardPath,
        scheduler_tick_seconds: this.config.scheduler_tick_seconds
      }
    };
  }

  async templateCreate(payload: unknown): Promise<ToolResponse<{ template_id: string }>> {
    let template: DashboardTemplate;
    try {
      template = coerceTemplate(payload);
    } catch (error) {
      return { ok: false, errors: [asErrorMessage(error)] };
    }
    const exists = await this.templateStore.get(template.id);
    if (exists) {
      return { ok: false, errors: [`template already exists: ${template.id}`] };
    }

    const errors = await this.validateTemplate(template);
    if (errors.length) return { ok: false, errors };

    await this.templateStore.upsert(template);
    const state = await this.loadState();
    if (!state.active_template_id) {
      state.active_template_id = template.id;
      await this.saveState(state);
    }

    return { ok: true, errors: [], data: { template_id: template.id } };
  }

  async templateUpdate(templateId: string, payload: unknown): Promise<ToolResponse<{ template_id: string }>> {
    const existing = await this.templateStore.get(templateId);
    if (!existing) {
      return { ok: false, errors: [`template not found: ${templateId}`] };
    }

    let template: DashboardTemplate;
    try {
      template = coerceTemplate(payload);
    } catch (error) {
      return { ok: false, errors: [asErrorMessage(error)] };
    }
    if (template.id !== templateId) {
      return { ok: false, errors: ['template id mismatch'] };
    }

    const errors = await this.validateTemplate(template);
    if (errors.length) return { ok: false, errors };

    await this.templateStore.upsert(template);
    return { ok: true, errors: [], data: { template_id: template.id } };
  }

  async templateDelete(templateId: string): Promise<ToolResponse<{ deleted_template_id: string; active_template_id: string | null }>> {
    const existing = await this.templateStore.get(templateId);
    if (!existing) {
      return { ok: false, errors: [`template not found: ${templateId}`] };
    }

    await this.templateStore.remove(templateId);

    const state = await this.loadState();
    delete state.template_runs[templateId];

    let activeTemplateId = state.active_template_id;
    if (activeTemplateId === templateId) {
      const remaining = await this.templateStore.list();
      activeTemplateId = remaining.length ? remaining[0].id : null;
      state.active_template_id = activeTemplateId;
    }

    await this.saveState(state);
    return {
      ok: true,
      errors: [],
      data: {
        deleted_template_id: templateId,
        active_template_id: activeTemplateId
      }
    };
  }

  async templateCopy(
    sourceTemplateId: string,
    newTemplateId: string,
    newName?: string,
    activate = false
  ): Promise<ToolResponse<{ source_template_id: string; template_id: string; active_template_id: string | null }>> {
    if (!newTemplateId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(newTemplateId)) {
      return { ok: false, errors: ['new_template_id is invalid'] };
    }

    const source = await this.templateStore.get(sourceTemplateId);
    if (!source) {
      return { ok: false, errors: [`source template not found: ${sourceTemplateId}`] };
    }

    const exists = await this.templateStore.get(newTemplateId);
    if (exists) {
      return { ok: false, errors: [`template already exists: ${newTemplateId}`] };
    }

    const copy: DashboardTemplate = {
      ...deepClone(source),
      id: newTemplateId,
      name: newName && newName.trim() ? newName.trim() : `${source.name} Copy`
    };

    const errors = await this.validateTemplate(copy);
    if (errors.length) return { ok: false, errors };

    await this.templateStore.upsert(copy);

    const state = await this.loadState();
    if (activate || !state.active_template_id) {
      state.active_template_id = newTemplateId;
      await this.saveState(state);
    }

    return {
      ok: true,
      errors: [],
      data: {
        source_template_id: sourceTemplateId,
        template_id: newTemplateId,
        active_template_id: state.active_template_id
      }
    };
  }

  async templateValidate(payload: unknown): Promise<ToolResponse<{ valid: boolean }>> {
    let template: DashboardTemplate;
    try {
      template = coerceTemplate(payload);
    } catch (error) {
      return { ok: false, errors: [asErrorMessage(error)], data: { valid: false } };
    }
    const errors = await this.validateTemplate(template);
    return {
      ok: errors.length === 0,
      errors,
      data: { valid: errors.length === 0 }
    };
  }

  async templateList(): Promise<ToolResponse<{ templates: Array<Record<string, unknown>> }>> {
    const templates = await this.templateStore.list();
    const state = await this.loadState();
    const now = Date.now();

    const items = templates.map((template) => {
      const runState = state.template_runs[template.id] || {};
      const lastAttemptMs = resolveLastAttemptMs(state, template.id);
      const intervalMs = template.schedule.every_minutes * 60_000;
      const nextDueAt = lastAttemptMs ? new Date(lastAttemptMs + intervalMs).toISOString() : null;
      const dueNow = !lastAttemptMs || now >= lastAttemptMs + intervalMs;

      return {
        id: template.id,
        name: template.name,
        enabled: template.enabled,
        active: state.active_template_id === template.id,
        schedule: template.schedule,
        due_now: dueNow,
        next_due_at: nextDueAt,
        last_attempt_at: runState.last_attempt_at || null,
        last_success_at: runState.last_success_at || null,
        last_status: runState.last_status || null,
        last_error: runState.last_error || null
      };
    });

    return { ok: true, errors: [], data: { templates: items } };
  }

  async templateActivate(templateId: string): Promise<ToolResponse<{ active_template_id: string }>> {
    const template = await this.templateStore.get(templateId);
    if (!template) {
      return { ok: false, errors: [`template not found: ${templateId}`] };
    }

    const state = await this.loadState();
    state.active_template_id = templateId;
    await this.saveState(state);
    return { ok: true, errors: [], data: { active_template_id: templateId } };
  }

  async runNow(templateId: string): Promise<ToolResponse<Record<string, unknown>>> {
    const template = await this.templateStore.get(templateId);
    if (!template) {
      return { ok: false, errors: [`template not found: ${templateId}`] };
    }

    const run = await this.executeAndPersist(template, 'manual');
    return {
      ok: run.status === 'success',
      errors: run.errors,
      data: {
        template_id: run.template_id,
        status: run.status,
        published: run.published,
        attempt_count: run.attempt_count,
        started_at: run.started_at,
        finished_at: run.finished_at
      }
    };
  }

  async status(): Promise<ToolResponse<RuntimeStatus>> {
    const state = await this.loadState();
    const templates = await this.templateStore.list();

    return {
      ok: true,
      errors: [],
      data: {
        active_template_id: state.active_template_id,
        template_count: templates.length,
        enabled_template_count: templates.filter((entry) => entry.enabled).length,
        running_template_ids: [...this.runningTemplates],
        state
      }
    };
  }

  async displayProfileSet(profile: Partial<DisplayProfile>): Promise<ToolResponse<{ display_profile: DisplayProfile }>> {
    const state = await this.loadState();
    const current = this.effectiveDisplayProfile(state);

    const next: DisplayProfile = {
      width_px: Math.max(320, Math.floor(profile.width_px ?? current.width_px)),
      height_px: Math.max(240, Math.floor(profile.height_px ?? current.height_px)),
      safe_top_px: Math.max(0, Math.floor(profile.safe_top_px ?? current.safe_top_px)),
      safe_bottom_px: Math.max(0, Math.floor(profile.safe_bottom_px ?? current.safe_bottom_px)),
      safe_side_px: Math.max(0, Math.floor(profile.safe_side_px ?? current.safe_side_px)),
      layout_safety_margin_px: Math.max(0, Math.floor(profile.layout_safety_margin_px ?? current.layout_safety_margin_px))
    };

    state.display_profile = next;
    await this.saveState(state);
    return { ok: true, errors: [], data: { display_profile: next } };
  }

  async tickScheduler(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;

    try {
      const templates = await this.templateStore.list();
      const state = await this.loadState();
      const now = Date.now();

      for (const template of templates) {
        if (!template.enabled) continue;
        if (this.runningTemplates.has(template.id)) continue;
        if (this.runningTemplates.size >= this.config.max_parallel_runs) break;

        const lastAttempt = resolveLastAttemptMs(state, template.id);
        const intervalMs = template.schedule.every_minutes * 60_000;
        const due = !lastAttempt || now >= lastAttempt + intervalMs;

        if (!due) continue;

        void this.executeAndPersist(template, 'schedule');
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  private async executeAndPersist(
    template: DashboardTemplate,
    trigger: 'schedule' | 'manual'
  ): Promise<RunArtifact> {
    const artifact = await this.executeTemplateRun(template, trigger);
    await this.persistRunArtifact(artifact);
    return artifact;
  }

  private async executeTemplateRun(
    template: DashboardTemplate,
    trigger: 'schedule' | 'manual'
  ): Promise<RunArtifact> {
    if (this.runningTemplates.has(template.id)) {
      const now = nowIso();
      return {
        template_id: template.id,
        trigger,
        status: 'failed',
        started_at: now,
        finished_at: now,
        duration_ms: 0,
        attempt_count: 0,
        published: false,
        errors: ['template run already in progress']
      };
    }

    this.runningTemplates.add(template.id);
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const errors: string[] = [];
    let attemptCount = 0;
    let published = false;
    let response: FillResponse | undefined;

    try {
      const state = await this.loadState();
      state.template_runs[template.id] = {
        ...(state.template_runs[template.id] || {}),
        last_attempt_at: startedAtIso,
        last_status: 'failed',
        last_error: undefined
      };
      await this.saveState(state);

      const retryCount = Math.max(0, template.run?.retry_count ?? this.config.default_retry_count);
      const repairAttempts = Math.max(0, template.run?.repair_attempts ?? 1);
      const currentValues = collectCurrentValues(template);

      for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        attemptCount = attempt + 1;
        try {
          let fillErrorHint: string | undefined;
          for (let repair = 0; repair <= repairAttempts; repair += 1) {
            const fillResponse = await this.fillRunner.run({
              template,
              currentValues,
              attempt: attempt + 1,
              errorHint: fillErrorHint
            });

            const shapeErrors = validateFillShape(fillResponse);
            if (shapeErrors.length) {
              throw new Error(shapeErrors.join('; '));
            }

            response = fillResponse;

            try {
              const merged = mergeTemplateValues(template, fillResponse.values);
              const profile = this.effectiveDisplayProfile(await this.loadState());
              await this.publisher.validateOnly(merged, profile);

              await this.writeRenderedSnapshot(template.id, merged);

              const latestState = await this.loadState();
              if (latestState.active_template_id === template.id) {
                await this.publisher.publish(merged, profile);
                published = true;
              }

              latestState.template_runs[template.id] = {
                ...(latestState.template_runs[template.id] || {}),
                last_attempt_at: startedAtIso,
                last_success_at: nowIso(),
                last_status: 'success',
                last_error: undefined
              };
              await this.saveState(latestState);
              return {
                template_id: template.id,
                trigger,
                status: 'success',
                started_at: startedAtIso,
                finished_at: nowIso(),
                duration_ms: Date.now() - startedAt,
                attempt_count: attemptCount,
                published,
                errors,
                response
              };
            } catch (error) {
              const message = asErrorMessage(error);
              if (repair < repairAttempts) {
                fillErrorHint = message;
                continue;
              }
              throw error;
            }
          }
        } catch (error) {
          const message = asErrorMessage(error);
          errors.push(message);
          if (attempt < retryCount) {
            await sleep(this.config.retry_backoff_seconds * 1000);
            continue;
          }
          break;
        }
      }

      const failedState = await this.loadState();
      failedState.template_runs[template.id] = {
        ...(failedState.template_runs[template.id] || {}),
        last_attempt_at: startedAtIso,
        last_status: 'failed',
        last_error: errors[errors.length - 1] || 'run failed'
      };
      await this.saveState(failedState);

      return {
        template_id: template.id,
        trigger,
        status: 'failed',
        started_at: startedAtIso,
        finished_at: nowIso(),
        duration_ms: Date.now() - startedAt,
        attempt_count: attemptCount,
        published,
        errors,
        response
      };
    } finally {
      this.runningTemplates.delete(template.id);
    }
  }

  async persistRunArtifact(artifact: RunArtifact): Promise<void> {
    await this.runStore.write(artifact.template_id, artifact);
  }

  private async validateTemplate(template: DashboardTemplate): Promise<string[]> {
    const errors = validateTemplateShape(template);
    if (errors.length) return errors;

    try {
      validateFieldPointers(template);
    } catch (error) {
      return [asErrorMessage(error)];
    }

    try {
      const profile = this.effectiveDisplayProfile(await this.loadState());
      await this.publisher.validateOnly(template.base_dashboard, profile);
    } catch (error) {
      return [asErrorMessage(error)];
    }

    return [];
  }

  private effectiveDisplayProfile(state: PlashboardState): DisplayProfile {
    return state.display_profile || this.config.display_profile;
  }

  private async seedDefaultTemplate(): Promise<boolean> {
    try {
      await access(this.paths.liveDashboardPath, fsConstants.R_OK);
    } catch {
      return false;
    }

    const text = await readFile(this.paths.liveDashboardPath, 'utf8');
    const dashboard = JSON.parse(text) as Record<string, unknown>;

    const template: DashboardTemplate = {
      id: 'default',
      name: 'Default Dashboard Template',
      enabled: true,
      schedule: {
        mode: 'interval',
        every_minutes: 10,
        timezone: this.config.timezone
      },
      base_dashboard: dashboard,
      fields: [],
      context: {
        dashboard_prompt: 'Fill dashboard values from current system state.'
      },
      run: {
        retry_count: this.config.default_retry_count,
        repair_attempts: 1
      }
    };

    await this.templateStore.upsert(template);
    return true;
  }

  private async writeRenderedSnapshot(templateId: string, payload: Record<string, unknown>): Promise<void> {
    const dir = join(this.paths.renderedDir, templateId);
    await ensureDir(dir);
    await atomicWriteJson(join(dir, 'latest.json'), payload);
  }

  private async loadState(): Promise<PlashboardState> {
    if (this.stateCache) return this.stateCache;
    this.stateCache = await this.stateStore.load();
    return this.stateCache;
  }

  private async saveState(state: PlashboardState): Promise<void> {
    this.stateCache = state;
    await this.stateStore.save(state);
  }
}
