import { describe, expect, it } from 'vitest';
import { UseCaseError } from '../errors.js';
import {
  EXPORT_FORMAT,
  checkImportSchema,
  checkImportTarget,
  exportSource,
  hostnameTravels,
  invitationFromExport,
  verifyExportManifest,
  type ExportArchive,
} from './portability.js';

const tenantId = '0192f7a0-0000-7000-8000-000000000001';

const manifest = (over: Record<string, unknown> = {}) => ({
  format: EXPORT_FORMAT,
  schemaVersion: '0028_connection_live_path',
  mycelVersion: 'test',
  exportedAt: '2026-10-28T00:00:00.000Z',
  tenant: { id: tenantId },
  tables: { forms: { file: 'tables/forms.ndjson', rows: 2, sha256: 'f', columns: [] } },
  media: {
    [`tenants/${tenantId}/a.png`]: {
      file: `media/tenants/${tenantId}/a.png`,
      bytes: 1,
      sha256: 'm',
      contentType: 'image/png',
    },
  },
  ...over,
});

const archive = (text: string, files: Record<string, string> = {}): ExportArchive => ({
  manifest: async () => text,
  table: async (file) => ({ sha256: files[file] ?? 'f', lines: 2 }),
  media: async (file) => files[file] ?? 'm',
});

const refused = async (promise: Promise<unknown>, message: RegExp) => {
  const e = await promise.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(UseCaseError);
  expect((e as UseCaseError).code).toBe('invalid_input');
  expect((e as UseCaseError).message).toMatch(message);
};

describe('verifyExportManifest', () => {
  it('returns a manifest whose every file matches', async () => {
    const m = await verifyExportManifest(archive(JSON.stringify(manifest())), ['forms']);
    expect(m.tenant.id).toBe(tenantId);
  });

  it('refuses what is not a manifest of this format', async () => {
    await refused(verifyExportManifest(archive('{'), ['forms']), /no readable manifest.json/);
    await refused(
      verifyExportManifest(archive(JSON.stringify(manifest({ format: 'x/1' }))), ['forms']),
      /format x\/1 is not/
    );
  });

  it('refuses a table this version does not know, or a file the format does not name', async () => {
    await refused(verifyExportManifest(archive(JSON.stringify(manifest())), []), /does not know/);
    const elsewhere = manifest({
      tables: { forms: { file: '../etc/passwd', rows: 2, sha256: 'f', columns: [] } },
    });
    await refused(
      verifyExportManifest(archive(JSON.stringify(elsewhere)), ['forms']),
      /outside the format/
    );
  });

  it('refuses media of another tenant or outside the format', async () => {
    const other = manifest({
      media: { 'tenants/other/a.png': { file: 'media/tenants/other/a.png', sha256: 'm' } },
    });
    await refused(
      verifyExportManifest(archive(JSON.stringify(other)), ['forms']),
      /not under the tenant/
    );
    const key = `tenants/${tenantId}/../x`;
    const traversal = manifest({ media: { [key]: { file: `media/${key}`, sha256: 'm' } } });
    await refused(
      verifyExportManifest(archive(JSON.stringify(traversal)), ['forms']),
      /outside the format/
    );
  });

  it('refuses a file that does not match its digest', async () => {
    const text = JSON.stringify(manifest());
    await refused(
      verifyExportManifest(archive(text, { 'tables/forms.ndjson': 'x' }), ['forms']),
      /tables\/forms.ndjson does not match/
    );
    await refused(
      verifyExportManifest(archive(text, { [`media/tenants/${tenantId}/a.png`]: 'x' }), ['forms']),
      /a.png does not match/
    );
  });
});

describe('import rules', () => {
  it('refuses only a newer schema', () => {
    expect(() => checkImportSchema('0027_a', '0028_b')).not.toThrow();
    expect(() => checkImportSchema('0028_b', '0028_b')).not.toThrow();
    expect(() => checkImportSchema('0029_c', '0028_b')).toThrow(/newer than this database/);
  });

  it('turns a membership into an invitation with known capabilities only', () => {
    expect(
      invitationFromExport({
        operator_email: ' Editor@Example.org ',
        capabilities: ['content:write', 'future:thing', 'content:write'],
      })
    ).toEqual({ email: 'editor@example.org', capabilities: ['content:write'] });
    expect(invitationFromExport({ operator_email: 'nope', capabilities: ['content:write'] })).toBe(
      null
    );
    expect(
      invitationFromExport({ operator_email: 'a@example.org', capabilities: ['future:thing'] })
    ).toBe(null);
  });

  it('lets only a custom hostname travel', () => {
    expect(hostnameTravels('custom')).toBe(true);
    expect(hostnameTravels('platform')).toBe(false);
  });
});

describe('export source and import target', () => {
  it('exports only a tenant that exists, and imports only where id and slug are free', () => {
    expect(exportSource({ id: tenantId }, 'site')).toEqual({ id: tenantId });
    expect(() => exportSource(null, 'site')).toThrow(
      new UseCaseError('not_found', 'no tenant with slug "site"')
    );
    expect(() => checkImportTarget({ id: false, slug: false }, tenantId, 'site')).not.toThrow();
    // The id first: the same tenant again is the likelier mistake, and its message says so.
    expect(() => checkImportTarget({ id: true, slug: true }, tenantId, 'site')).toThrow(
      `tenant ${tenantId} exists in this database`
    );
    expect(() => checkImportTarget({ id: false, slug: true }, tenantId, 'site')).toThrow(
      'a tenant with slug "site" exists'
    );
  });
});
