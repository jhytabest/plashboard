import { describe, expect, it } from 'vitest';
import { mergeTemplateValues, validateFieldPointers } from './merge.js';
import type { DashboardTemplate } from './types.js';

function baseTemplate(): DashboardTemplate {
  return {
    id: 'ops',
    name: 'Ops',
    enabled: true,
    schedule: {
      mode: 'interval',
      every_minutes: 10,
      timezone: 'Europe/Berlin'
    },
    base_dashboard: {
      title: 'Dashboard',
      summary: 'Old',
      ui: { timezone: 'Europe/Berlin' },
      sections: [
        {
          id: 'sec',
          label: 'Section',
          cards: [
            {
              id: 'card',
              title: 'Card',
              description: 'desc'
            }
          ]
        }
      ],
      alerts: []
    },
    fields: [
      {
        id: 'summary',
        pointer: '/summary',
        type: 'string',
        prompt: 'Summary',
        required: true,
        constraints: { max_len: 80 }
      }
    ]
  };
}

describe('mergeTemplateValues', () => {
  it('merges valid values into base dashboard', () => {
    const template = baseTemplate();
    const merged = mergeTemplateValues(template, { summary: 'New summary' });
    expect(merged.summary).toBe('New summary');
    expect(template.base_dashboard.summary).toBe('Old');
  });

  it('rejects unknown field ids', () => {
    const template = baseTemplate();
    expect(() => mergeTemplateValues(template, { nope: 'x' })).toThrow(/unknown field id/i);
  });

  it('validates pointers exist in base dashboard', () => {
    const template = baseTemplate();
    template.fields[0].pointer = '/missing';
    expect(() => validateFieldPointers(template)).toThrow(/pointer path not found/i);
  });
});
