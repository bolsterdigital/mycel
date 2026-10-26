// Authenticated Lighthouse reports stay recoverable without publishing page bodies or cookies.
// CMS uses the tracked public recipient certificate; the private key is operator-owned, outside
// git and CI. Rejected: deleting private evidence or uploading it in plaintext to a public repo.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function protectReports(
  directory,
  recipient = fileURLToPath(new URL('./artifact-recipient.pem', import.meta.url))
) {
  const out = resolve(directory);
  if (!existsSync(join(out, 'private'))) return;
  const archive = join(out, 'private.tar.gz');
  try {
    execFileSync('tar', ['-czf', archive, '-C', out, 'private']);
    execFileSync('openssl', [
      'cms',
      '-encrypt',
      '-binary',
      '-aes-256-cbc',
      '-in',
      archive,
      '-out',
      join(out, 'private.tar.gz.cms'),
      '-outform',
      'DER',
      recipient,
    ]);
  } finally {
    rmSync(archive, { force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) protectReports(process.argv[2]);
