// The dry run of the WordPress import: `node dist/cli.js --file <export.xml> [--default-locale nl]
// --dry-run` prints the report of the plan and changes nothing. Running the plan against a tenant
// arrives with the registry wiring (brief wordpress-import-execution, PR 2) and will move this
// entry into the `mycel` CLI, which already composes the registry; until then a call without
// `--dry-run` is refused instead of pretending to import. Rejected: putting the dry run in the
// `mycel` CLI now (it would load the database configuration for a step that reads one file).

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { plan } from './plan.js';
import { formatReport } from './report.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    'default-locale': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

if (!values.file) {
  process.stderr.write('usage: import-wordpress --file <export.xml> --dry-run [--json]\n');
  process.exit(2);
}
if (!values['dry-run']) {
  process.stderr.write('only --dry-run is available; importing into a tenant is not built yet\n');
  process.exit(2);
}
const result = plan(readFileSync(values.file, 'utf8'), {
  ...(values['default-locale'] && { defaultLocale: values['default-locale'] }),
});
process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result));
