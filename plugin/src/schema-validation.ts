import Ajv2020Module from 'ajv/dist/2020.js';
import templateSchema from '../schema/template.schema.json' with { type: 'json' };
import fillResponseSchema from '../schema/fill-response.schema.json' with { type: 'json' };
import type { DashboardTemplate, FillResponse } from './types.js';

const Ajv2020Ctor = (Ajv2020Module as unknown as { default?: new (...args: any[]) => any }).default
  ?? (Ajv2020Module as unknown as new (...args: any[]) => any);
const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });

type AjvValidator<T> = ((value: unknown) => value is T) & { errors?: unknown };

const validateTemplateSchema = ajv.compile(templateSchema) as AjvValidator<DashboardTemplate>;
const validateFillSchema = ajv.compile(fillResponseSchema) as AjvValidator<FillResponse>;

function errorsToStrings(errors: unknown): string[] {
  if (!Array.isArray(errors)) return ['schema validation failed'];
  return errors.map((entry) => {
    const item = entry as { instancePath?: string; message?: string };
    return `${item.instancePath || '/'} ${item.message || 'invalid'}`.trim();
  });
}

export function validateTemplateShape(template: unknown): string[] {
  if (validateTemplateSchema(template)) {
    return [];
  }
  return errorsToStrings(validateTemplateSchema.errors);
}

export function validateFillShape(response: unknown): string[] {
  if (validateFillSchema(response)) {
    return [];
  }
  return errorsToStrings(validateFillSchema.errors);
}
