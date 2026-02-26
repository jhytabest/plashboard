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

export function registerPlashboardPlugin(api: UnknownApi): void {
  const config = resolveConfig(api);
  const runtime = new PlashboardRuntime(config, {
    info: (...args) => api.logger?.info?.(...args),
    warn: (...args) => api.logger?.warn?.(...args),
    error: (...args) => api.logger?.error?.(...args)
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
          'unknown command. supported: init, status, list, activate <id>, delete <id>, copy <src> <new-id> [new-name] [activate], run <id>, set-display <width> <height> <top> <bottom>'
        ]
      });
    }
  });
}
