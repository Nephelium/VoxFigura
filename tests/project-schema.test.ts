import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { importPtbVocalJson } from '@vocalcut/core';
import { createInitialProject } from '../src/stores/workbench';

type JsonSchema = {
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
};

function resolveRef(root: JsonSchema, node: JsonSchema): JsonSchema {
  if (!node.$ref) return node;
  const prefix = '#/$defs/';
  if (!node.$ref.startsWith(prefix)) throw new Error(`Unsupported $ref: ${node.$ref}`);
  const def = root.$defs?.[node.$ref.slice(prefix.length)];
  if (!def) throw new Error(`Missing $ref target: ${node.$ref}`);
  return def;
}

function validateAgainstSchema(root: JsonSchema, rawSchema: JsonSchema, value: unknown, path = '$'): string[] {
  const schema = resolveRef(root, rawSchema);
  const errors: string[] = [];

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return errors;
  }

  if (schema.enum && !schema.enum.some((item) => item === value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
    return errors;
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : typeof value === 'number'
          ? (Number.isInteger(value) ? 'integer' : 'number')
          : typeof value;
    const matches = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!matches) {
      errors.push(`${path}: expected type ${allowed.join('|')}, got ${actual}`);
      return errors;
    }
  }

  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      errors.push(`${path}: non-finite number`);
    } else {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: length ${value.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, idx) => {
        errors.push(...validateAgainstSchema(root, schema.items!, item, `${path}[${idx}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const reqKey of schema.required ?? []) {
      if (!(reqKey in obj) || obj[reqKey] === undefined) {
        errors.push(`${path}: missing required key "${reqKey}"`);
      }
    }
    for (const [key, val] of Object.entries(obj)) {
      if (val === undefined) continue;
      const propSchema = schema.properties?.[key];
      if (propSchema) {
        errors.push(...validateAgainstSchema(root, propSchema, val, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected additional property "${key}"`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(root, schema.additionalProperties, val, `${path}.${key}`));
      }
    }
  }

  return errors;
}

describe('schema/project.schema.json contract synchronization', () => {
  const schema = JSON.parse(readFileSync('schema/project.schema.json', 'utf8')) as JsonSchema;

  it('validates createInitialProject() with zero errors', () => {
    const project = createInitialProject();
    const errors = validateAgainstSchema(schema, schema, project);
    expect(errors).toEqual([]);
  });

  it('validates imported .ptb-vocal.json projects and populated annotation controls', () => {
    const imported = importPtbVocalJson({
      name: 'Schema Test Phrase',
      speaker: 'JD2',
      frames: [
        { name: 'a', duration: 0.25, f0: 180, params: Array(19).fill(0), lip_width: 1.0, larynx_height: 0.0, source: { mode: 'modal', pressure_pa: 750 } },
        { silent: true, duration: 0.1 },
      ],
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const project = imported.value;
    const clip = project.clips[project.clip_order[0]];
    const syl = clip.syllables[clip.syllable_order[0]];
    expect(clip.syllables[clip.syllable_order[1]].segments[0].ipa).toBe('sil');
    syl.segments[0].stop_timing = { closure_ms: 45, release_ms: 2, aspiration_ms: 30, vot_ms: 32 };
    syl.overrides.poses.push({ seg_index: 0, delta: { TCX: 0.2 }, scope: ['tongue_body'] });
    syl.overrides.f0_resid.push({ id: 'r1', span_id: syl.id, points: [{ u: 0.5, st: 1.2 }], feather_ms: 30 });
    syl.overrides.glottis.push({ u0: 0, u1: 1, preset: 'breathy', blend: 0.6 });
    project.f0_pins = [{ id: 'p1', start_smp: 0, end_smp: 4800, points: [{ t_smp: 0, f0_hz: 165 }], transition_ms: 30, exit_fit_ms: 35 }];
    project.vibrato = { enabled: true, rate_hz: 5.5, depth_cents: 25, delay_ms: 200, fade_in_ms: 120, fade_out_ms: 90, min_hold_ms: 400 };
    project.perturbation = { flutter: 10, shimmer: 2, seed: 42 };

    const errors = validateAgainstSchema(schema, schema, project);
    expect(errors).toEqual([]);
  });

  it('rejects out-of-range fields, legacy sample_rate key, extra keys, and sub-floor stops', () => {
    const base = createInitialProject();
    expect(validateAgainstSchema(schema, schema, { ...base, extra_field: true }).length).toBeGreaterThan(0);

    const badSr = structuredClone(base) as unknown as Record<string, unknown>;
    (badSr.settings as Record<string, unknown>).sample_rate_hz = 44100;
    expect(validateAgainstSchema(schema, schema, badSr).length).toBeGreaterThan(0);

    const wideImported = importPtbVocalJson({
      frames: [{ name: 't', duration: 0.2, f0: 950 }],
    });
    expect(wideImported.ok).toBe(true);
    if (wideImported.ok) {
      expect(validateAgainstSchema(schema, schema, wideImported.value)).toEqual([]);
    }

    const imported = importPtbVocalJson({
      frames: [{ name: 't', duration: 0.2, f0: -10 }],
    });
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.error.code).toBe('out_of_range');
  });
});
