import { describe, expect, it } from 'vitest';
import { METHOD_REFERENCES } from '../src/data/references';
import { editionReferences as hackathonEditionReferences } from '../src/editions/hackathon/index';

const LEGACY_MODULE_PATTERN = /^(?:M\d{2}|P\d{2}(?:-.+)?|shared-runtime)$/;
const LEGACY_CODE_IN_ID_OR_NOTE = /\b(?:M\d{2}|P\d{2})\b/;

describe('method references module classification and importance sorting', () => {
  it('preserves all 111 base entries and 2 hackathon edition entries with no duplicates', () => {
    const baseIds = METHOD_REFERENCES.map((r) => r.id);
    expect(METHOD_REFERENCES.length).toBe(111);
    expect(new Set(baseIds).size).toBe(111);

    const hackIds = hackathonEditionReferences.map((r) => r.id);
    expect(hackathonEditionReferences.length).toBe(2);
    expect(new Set([...baseIds, ...hackIds]).size).toBe(113);
  });

  it('maps every entry to VoxFigura modules with no legacy Mxx/Pxx tags or IDs', () => {
    for (const ref of [...METHOD_REFERENCES, ...hackathonEditionReferences]) {
      expect(ref.modules.length, `${ref.id} should belong to at least one module`).toBeGreaterThan(0);
      expect(ref.id, `${ref.id} should not keep legacy Mxx/Pxx prefix`).not.toMatch(LEGACY_CODE_IN_ID_OR_NOTE);
      expect(ref.reference_note, `${ref.id} note should not mention legacy Mxx/Pxx`).not.toMatch(
        LEGACY_CODE_IN_ID_OR_NOTE,
      );
      for (const mod of ref.modules) {
        expect(mod, `${ref.id} still has legacy module tag ${mod}`).not.toMatch(LEGACY_MODULE_PATTERN);
      }
      expect(typeof ref.importance, `${ref.id} should have numeric importance`).toBe('number');
    }
  });

  it('sorts METHOD_REFERENCES and any module subset in descending importance order', () => {
    for (let i = 1; i < METHOD_REFERENCES.length; i += 1) {
      expect(METHOD_REFERENCES[i - 1].importance ?? 0).toBeGreaterThanOrEqual(
        METHOD_REFERENCES[i].importance ?? 0,
      );
    }

    const modules = new Set(METHOD_REFERENCES.flatMap((r) => r.modules));
    for (const mod of modules) {
      const subset = METHOD_REFERENCES.filter((r) => r.modules.includes(mod));
      expect(subset.length).toBeGreaterThan(0);
      for (let i = 1; i < subset.length; i += 1) {
        expect(subset[i - 1].importance ?? 0).toBeGreaterThanOrEqual(subset[i].importance ?? 0);
      }
    }
  });
});
