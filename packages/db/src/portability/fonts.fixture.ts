// One uploaded font face for the conformance fixtures (MY-302): RLS needs a row in `site_fonts`
// and `site_font_faces` to make its zero meaningful, and the export must carry both tables.
// The bytes are not a font: the validator belongs to `@mycel/media-sharp`, and what is tested
// here is where the rows go, not what they hold.
import type { Kysely } from 'kysely';
import { uploadSiteFontFace } from '../theme/site-fonts.js';
import type { Database } from '../infra/schema.js';

export async function seedSiteFont(operatorDb: Kysely<Database>, tenantId: string): Promise<void> {
  await uploadSiteFontFace(
    operatorDb,
    tenantId,
    {
      family: {
        role: 'heading',
        family: 'Fixture Sans',
        category: 'sans',
        licence: { holder: 'Fixture', source: 'Fixture Foundry', domains: ['example.org'] },
      },
      weight: 700,
      style: 'normal',
      bytes: new Uint8Array(64).fill(7),
      replaceFamily: false,
    },
    // A fixed digest: the audit row's hash is not what this fixture is about.
    { actorId: 'fixture', hasher: { hash: async () => '0'.repeat(64) } },
    () => {}
  );
}
