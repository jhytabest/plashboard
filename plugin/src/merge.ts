import type { DashboardTemplate, FieldSpec } from './types.js';
import { deepClone } from './utils.js';
import { readPointer, writePointer } from './json-pointer.js';

function assertFieldValue(field: FieldSpec, value: unknown): void {
  const required = field.required !== false;
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`missing required value for field ${field.id}`);
    }
    return;
  }

  if (field.type === 'string') {
    if (typeof value !== 'string') {
      throw new Error(`field ${field.id} expects string`);
    }
    if (field.constraints?.max_len && value.length > field.constraints.max_len) {
      throw new Error(`field ${field.id} exceeds max_len=${field.constraints.max_len}`);
    }
  }

  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`field ${field.id} expects number`);
    }
    if (typeof field.constraints?.min === 'number' && value < field.constraints.min) {
      throw new Error(`field ${field.id} below min=${field.constraints.min}`);
    }
    if (typeof field.constraints?.max === 'number' && value > field.constraints.max) {
      throw new Error(`field ${field.id} above max=${field.constraints.max}`);
    }
  }

  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error(`field ${field.id} expects boolean`);
    }
  }

  if (field.type === 'array') {
    if (!Array.isArray(value)) {
      throw new Error(`field ${field.id} expects array`);
    }
    if (typeof field.constraints?.min_items === 'number' && value.length < field.constraints.min_items) {
      throw new Error(`field ${field.id} requires at least ${field.constraints.min_items} items`);
    }
    if (typeof field.constraints?.max_items === 'number' && value.length > field.constraints.max_items) {
      throw new Error(`field ${field.id} allows at most ${field.constraints.max_items} items`);
    }
  }

  if (field.constraints?.enum && !field.constraints.enum.includes(value as never)) {
    throw new Error(`field ${field.id} value not in enum`);
  }
}

export function validateFieldPointers(template: DashboardTemplate): void {
  const seenPointers = new Set<string>();
  const seenIds = new Set<string>();

  for (const field of template.fields) {
    if (seenIds.has(field.id)) {
      throw new Error(`duplicate field id: ${field.id}`);
    }
    seenIds.add(field.id);

    if (seenPointers.has(field.pointer)) {
      throw new Error(`duplicate field pointer: ${field.pointer}`);
    }
    seenPointers.add(field.pointer);

    readPointer(template.base_dashboard, field.pointer);
  }
}

export function mergeTemplateValues(
  template: DashboardTemplate,
  values: Record<string, unknown>
): Record<string, unknown> {
  const next = deepClone(template.base_dashboard);
  const knownIds = new Set(template.fields.map((field) => field.id));

  for (const fieldId of Object.keys(values)) {
    if (!knownIds.has(fieldId)) {
      throw new Error(`unknown field id in fill response: ${fieldId}`);
    }
  }

  for (const field of template.fields) {
    const value = values[field.id];
    assertFieldValue(field, value);

    if (value !== undefined && value !== null) {
      writePointer(next, field.pointer, value);
    }
  }

  return next;
}

export function collectCurrentValues(template: DashboardTemplate): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of template.fields) {
    values[field.id] = readPointer(template.base_dashboard, field.pointer);
  }
  return values;
}
