/* eslint-disable ts-patterns/no-magic-numbers -- version numbers read more clearly as literals in tests */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORMAT_NAMES, jsonSchemaFor } from '../src/domain/jsonSchemas.js';
import { latestProfile, profileVersions } from '../src/domain/lookup.js';
import { SpecialistProfile } from '../src/domain/schemas.js';
import { StoreError } from '../src/storage/store.js';
import { APP_ROOT, SCHEMAS_DIR } from '../src/paths.js';
import { post, testLab } from './helpers.js';

describe('specialist profile versioning', () => {
  it('saves an edit as a new version and keeps the old version and its results unchanged', async () => {
    const lab = await testLab();
    const v1 = latestProfile(lab.store.snapshot(), 'research');
    if (!v1) throw new Error('fixture missing');
    const fields = Object.fromEntries([
      ['name', v1.name],
      ['purpose', v1.purpose],
      ['changeNote', 'Added a criterion'],
      ['capabilities[0][id]', 'primary'],
      ['capabilities[0][name]', 'Research'],
      ...v1.criteria.flatMap((c, i) => [
        [`criteria[${i}][id]`, c.id],
        [`criteria[${i}][name]`, c.name],
        [`criteria[${i}][tier]`, c.tier],
        [`criteria[${i}][weight]`, String(c.weight)],
        [`criteria[${i}][capability]`, c.capability],
        [`criteria[${i}][methods]`, 'manual'],
        ...(c.mandatory ? [[`criteria[${i}][mandatory]`, 'on']] : []),
      ]),
      [`criteria[${v1.criteria.length}][name]`, 'States what would change the conclusion'],
      [`criteria[${v1.criteria.length}][tier]`, 'optional'],
    ]);
    const res = await post(lab, '/profiles/research/edit', fields);
    expect(res.status).toBe(303);
    const versions = profileVersions(lab.store.snapshot(), 'research');
    expect(versions.map((p) => p.version)).toEqual([2, 1]);
    expect(versions[0]?.criteria.map((c) => c.id)).toContain('states-what-would-change-the-conclusion');
    expect(versions[1]).toEqual(v1);
    expect(lab.store.snapshot().results.filter((r) => r.profileId === 'research').every((r) => r.profileVersion === 1)).toBe(true);
  });

  it('never overwrites a saved profile version', async () => {
    const lab = await testLab();
    const v1 = latestProfile(lab.store.snapshot(), 'master');
    if (!v1) throw new Error('fixture missing');
    await expect(lab.store.replace('profiles', { ...v1, name: 'changed' })).rejects.toThrow(StoreError);
    await expect(lab.store.add('profiles', v1)).rejects.toThrow('already exists');
  });

  it('refuses a profile whose criteria repeat an id or name an unknown capability', () => {
    const base = { schema: 'eval-lab/specialist-profile', schemaVersion: 1, id: 'p', version: 1, name: 'P', createdAt: '2026-10-01T00:00:00Z', origin: 'user', capabilities: [{ id: 'primary', name: 'Main' }] };
    const twice = SpecialistProfile.safeParse({ ...base, criteria: [{ id: 'a', name: 'A', tier: 'core', methods: ['manual'] }, { id: 'a', name: 'A2', tier: 'core', methods: ['manual'] }] });
    expect(twice.success ? '' : twice.error.message).toContain('used twice');
    const unknownCap = SpecialistProfile.safeParse({ ...base, criteria: [{ id: 'a', name: 'A', tier: 'core', capability: 'nope', methods: ['manual'] }] });
    expect(unknownCap.success ? '' : unknownCap.error.message).toContain('unknown capability');
  });

  it('accepts a brand-new specialist without any code change', async () => {
    const lab = await testLab(false);
    const res = await post(lab, '/profiles', {
      id: 'finance-notes',
      name: 'Finance notes',
      'capabilities[0][id]': 'primary',
      'capabilities[0][name]': 'Note quality',
      'criteria[0][name]': 'Accurate figures',
      'criteria[0][tier]': 'core',
      'criteria[0][mandatory]': 'on',
      'criteria[0][methods]': 'manual',
    });
    expect(res.status).toBe(303);
    expect(latestProfile(lab.store.snapshot(), 'finance-notes')?.criteria[0]).toMatchObject({ id: 'accurate-figures', mandatory: true });
  });
});

describe('documented formats', () => {
  it.each(FORMAT_NAMES)('schemas/%s.schema.json matches the code (run "npm run schemas" after changing a format)', (name) => {
    const committed: unknown = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), 'utf8'));
    expect(committed).toEqual(jsonSchemaFor(name));
  });

  it('every synthetic fixture is valid and cross-references resolve', () => {
    const tsx = join(APP_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const output = execFileSync(process.execPath, [tsx, join(APP_ROOT, 'scripts', 'check-fixtures.ts')], { cwd: APP_ROOT, encoding: 'utf8' });
    expect(output).toContain('All fixtures are valid.');
  });
});
