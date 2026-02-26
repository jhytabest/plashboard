export type FillFieldType = 'string' | 'number' | 'boolean' | 'array';

export interface DisplayProfile {
  width_px: number;
  height_px: number;
  safe_top_px: number;
  safe_bottom_px: number;
  safe_side_px: number;
  layout_safety_margin_px: number;
}

export interface ModelDefaults {
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface PlashboardConfig {
  data_dir: string;
  timezone: string;
  scheduler_tick_seconds: number;
  max_parallel_runs: number;
  default_retry_count: number;
  retry_backoff_seconds: number;
  session_timeout_seconds: number;
  fill_provider: 'command' | 'mock';
  fill_command?: string;
  python_bin: string;
  writer_script_path: string;
  dashboard_output_path: string;
  layout_overflow_tolerance_px: number;
  display_profile: DisplayProfile;
  model_defaults: ModelDefaults;
}

export interface TemplateSchedule {
  mode: 'interval';
  every_minutes: number;
  timezone: string;
}

export interface TemplateContext {
  dashboard_prompt?: string;
  section_prompts?: Record<string, string>;
  card_prompts?: Record<string, string>;
}

export interface FieldConstraints {
  max_len?: number;
  min?: number;
  max?: number;
  enum?: Array<string | number | boolean>;
  min_items?: number;
  max_items?: number;
}

export interface FieldSpec {
  id: string;
  pointer: string;
  type: FillFieldType;
  prompt: string;
  required?: boolean;
  constraints?: FieldConstraints;
}

export interface TemplateRunConfig {
  retry_count?: number;
  repair_attempts?: number;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface DashboardTemplate {
  id: string;
  name: string;
  enabled: boolean;
  schedule: TemplateSchedule;
  base_dashboard: Record<string, unknown>;
  fields: FieldSpec[];
  context?: TemplateContext;
  run?: TemplateRunConfig;
}

export interface TemplateRunState {
  last_attempt_at?: string;
  last_success_at?: string;
  last_status?: 'success' | 'failed';
  last_error?: string;
}

export interface PlashboardState {
  version: 1;
  active_template_id: string | null;
  template_runs: Record<string, TemplateRunState>;
  display_profile?: DisplayProfile;
}

export interface RunArtifact {
  template_id: string;
  trigger: 'schedule' | 'manual';
  status: 'success' | 'failed';
  started_at: string;
  finished_at: string;
  duration_ms: number;
  attempt_count: number;
  published: boolean;
  errors: string[];
  response?: unknown;
}

export interface ToolResponse<T = Record<string, unknown>> {
  ok: boolean;
  errors: string[];
  data?: T;
}

export interface FillResponse {
  values: Record<string, unknown>;
}

export interface FillRunContext {
  template: DashboardTemplate;
  currentValues: Record<string, unknown>;
  attempt: number;
  errorHint?: string;
}

export interface FillRunner {
  run(context: FillRunContext): Promise<FillResponse>;
}

export interface RuntimeStatus {
  active_template_id: string | null;
  template_count: number;
  enabled_template_count: number;
  running_template_ids: string[];
  state: PlashboardState;
}
