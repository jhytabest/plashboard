import { spawn } from 'node:child_process';
import type { FillResponse, FillRunContext, FillRunner, PlashboardConfig } from './types.js';

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

function mockValue(type: string, currentValue: unknown, fieldId: string): unknown {
  if (type === 'number') return typeof currentValue === 'number' ? currentValue : 0;
  if (type === 'boolean') return typeof currentValue === 'boolean' ? currentValue : false;
  if (type === 'array') return Array.isArray(currentValue) ? currentValue : [];
  const now = new Date().toISOString();
  return `updated ${fieldId} at ${now}`;
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

function runCommand(command: string, promptPayload: Record<string, unknown>, timeoutSeconds: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: {
        ...process.env,
        PLASHBOARD_PROMPT_JSON: JSON.stringify(promptPayload)
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fill command timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`fill command failed (code=${code}): ${stderr.trim() || 'no stderr'}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

class CommandFillRunner implements FillRunner {
  constructor(private readonly config: PlashboardConfig) {}

  async run(context: FillRunContext): Promise<FillResponse> {
    if (!this.config.fill_command) {
      throw new Error('fill_provider=command but fill_command is not configured');
    }

    const promptPayload = buildPromptPayload(context);
    const output = await runCommand(this.config.fill_command, promptPayload, this.config.session_timeout_seconds);

    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error('fill command returned non-JSON output');
    }

    return parsed as FillResponse;
  }
}

export function createFillRunner(config: PlashboardConfig): FillRunner {
  if (config.fill_provider === 'command') {
    return new CommandFillRunner(config);
  }
  return new MockFillRunner();
}
