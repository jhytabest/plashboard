import { runAndReadStdout, type CommandRunner } from './command-runner.js';
import type { FillResponse, FillRunContext, FillRunner, PlashboardConfig } from './types.js';

export interface FillRunnerDeps {
  commandRunner?: CommandRunner | null;
}

function buildPromptPayload(context: FillRunContext): Record<string, unknown> {
  return {
    instructions: {
      system: [
        'Return JSON only.',
        'Return exactly one object: {"values": {...}}.',
        'Do not include markdown, explanations, or extra keys.'
      ],
      error_hint: context.errorHint || ''
    },
    template: {
      id: context.template.id,
      name: context.template.name,
      context: context.template.context || {}
    },
    fields: context.template.fields.map((field) => ({
      id: field.id,
      type: field.type,
      prompt: field.prompt,
      required: field.required !== false,
      constraints: field.constraints || {},
      current_value: context.currentValues[field.id]
    })),
    expected_response_schema: {
      values: {
        '<field_id>': '<typed value>'
      }
    }
  };
}

function buildOpenClawMessage(context: FillRunContext): string {
  const payload = buildPromptPayload(context);
  return [
    'Fill dashboard fields from the provided template context.',
    'Return exactly one JSON object with this shape: {"values": {...}}.',
    'Do not include markdown, comments, explanations, or extra keys.',
    JSON.stringify(payload)
  ].join('\n\n');
}

function mockValue(type: string, currentValue: unknown, fieldId: string): unknown {
  if (type === 'number') return typeof currentValue === 'number' ? currentValue : 0;
  if (type === 'boolean') return typeof currentValue === 'boolean' ? currentValue : false;
  if (type === 'array') return Array.isArray(currentValue) ? currentValue : [];
  const now = new Date().toISOString();
  return `updated ${fieldId} at ${now}`;
}

function tryParseJson(input: string): unknown | undefined {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) return trimmed;
  const lines = trimmed.split('\n');
  if (lines.length < 3) return trimmed;
  return lines.slice(1, -1).join('\n').trim();
}

function parseJsonCandidate(input: string): unknown | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return direct;

  const unfenced = stripCodeFence(trimmed);
  if (unfenced !== trimmed) {
    const parsed = tryParseJson(unfenced);
    if (parsed !== undefined) return parsed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const maybeObject = trimmed.slice(start, end + 1);
    const parsed = tryParseJson(maybeObject);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractFillResponse(value: unknown, depth = 0): FillResponse | null {
  if (depth > 10) return null;

  if (typeof value === 'string') {
    const parsed = parseJsonCandidate(value);
    if (parsed !== undefined) {
      return extractFillResponse(parsed, depth + 1);
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFillResponse(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const objectValue = asObject(value);
  if (!objectValue) return null;

  const valuesRecord = asObject(objectValue.values);
  if (valuesRecord) {
    return { values: valuesRecord };
  }

  for (const nested of Object.values(objectValue)) {
    const found = extractFillResponse(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseFillResponse(output: string, source: string): FillResponse {
  const extracted = extractFillResponse(output);
  if (!extracted) {
    throw new Error(`${source} output did not include a valid {"values": ...} JSON object`);
  }
  return extracted;
}

class MockFillRunner implements FillRunner {
  async run(context: FillRunContext): Promise<FillResponse> {
    const values: Record<string, unknown> = {};
    for (const field of context.template.fields) {
      values[field.id] = mockValue(field.type, context.currentValues[field.id], field.id);
    }
    return { values };
  }
}

class CommandFillRunner implements FillRunner {
  constructor(
    private readonly config: PlashboardConfig,
    private readonly commandRunner: CommandRunner | null
  ) {}

  async run(context: FillRunContext): Promise<FillResponse> {
    if (!this.config.allow_command_fill) {
      throw new Error('fill_provider=command is disabled; set allow_command_fill=true to enable it');
    }
    if (!this.config.fill_command) {
      throw new Error('fill_provider=command but fill_command is not configured');
    }

    const output = await runAndReadStdout(
      this.commandRunner,
      ['sh', '-lc', this.config.fill_command],
      {
        timeoutMs: this.config.session_timeout_seconds * 1000,
        env: {
          PLASHBOARD_PROMPT_JSON: JSON.stringify(buildPromptPayload(context))
        }
      },
      'fill command'
    );

    return parseFillResponse(output, 'fill command');
  }
}

class OpenClawFillRunner implements FillRunner {
  constructor(
    private readonly config: PlashboardConfig,
    private readonly commandRunner: CommandRunner | null
  ) {}

  async run(context: FillRunContext): Promise<FillResponse> {
    const agentId = (this.config.openclaw_fill_agent_id || 'main').trim() || 'main';
    const timeoutSeconds = Math.max(10, Math.floor(this.config.session_timeout_seconds));
    const message = buildOpenClawMessage(context);

    const output = await runAndReadStdout(
      this.commandRunner,
      ['openclaw', 'agent', '--agent', agentId, '--message', message, '--json', '--timeout', String(timeoutSeconds)],
      {
        timeoutMs: (timeoutSeconds + 30) * 1000
      },
      'openclaw fill'
    );

    return parseFillResponse(output, 'openclaw fill');
  }
}

export function createFillRunner(config: PlashboardConfig, deps: FillRunnerDeps = {}): FillRunner {
  const commandRunner = deps.commandRunner ?? null;
  if (config.fill_provider === 'command') {
    return new CommandFillRunner(config, commandRunner);
  }
  if (config.fill_provider === 'openclaw') {
    return new OpenClawFillRunner(config, commandRunner);
  }
  return new MockFillRunner();
}
