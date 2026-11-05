// The entry names of a tar archive, for the export e2e. `execFile` buffers stdout
// up to 1 MiB and then kills tar with `stdout maxBuffer length exceeded`: on a long-lived local
// database the probe tenant's archive lists more than that, so the export test failed on the
// harness, not on the archive. This reads the listing line by line from a stream, keeps the
// names, and fails on tar's own exit status with its stderr, so a broken archive stays red.
// Rejected: a larger `maxBuffer` (the same cliff, further out) and a filtered listing (the test
// asserts on names it would have to know in advance).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** More names than this is no archive the export writes; refuse instead of growing forever. */
export const MAX_ENTRIES = 1_000_000;

const STDERR_LIMIT = 4096;

/**
 * Every entry name in `file`, in archive order, as `tar -tf` prints it.
 * @param {string} file
 * @returns {Promise<string[]>}
 */
export function tarEntries(file) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-tf', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const entries = [];
    let stderr = '';
    let refused = false;
    tar.stderr.setEncoding('utf8');
    tar.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    const lines = createInterface({ input: tar.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line === '' || refused) return;
      if (entries.length === MAX_ENTRIES) {
        refused = true;
        tar.kill();
        return;
      }
      entries.push(line);
    });
    tar.on('error', reject);
    // `close` fires after stdout ended, so every line is in `entries` by then.
    tar.on('close', (code, signal) => {
      if (refused) reject(new Error(`tar -tf ${file}: more than ${MAX_ENTRIES} entries`));
      else if (code === 0) resolve(entries);
      else
        reject(
          new Error(
            `tar -tf ${file} exited with ${code ?? signal}: ${stderr.trim() || '(no stderr)'}`
          )
        );
    });
  });
}
