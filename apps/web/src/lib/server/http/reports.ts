// The collector behind Reporting-Endpoints: a browser posts what it blocked or deprecated, so a
// strict policy that breaks a page shows up in the log before someone complains.
//
// Anyone can post here, so nothing is believed and little is kept. A report becomes one log line of
// short, checked scalars; no address, cookie, user agent, query string or sample of the blocked
// code, because a URL can carry a token and a log line is a copy (ADR 019 rule 8). The budget keeps
// a flood from writing more than this many lines per process. Rejected: storing reports in the
// database, an unauthenticated write path for something the log already answers.

const REPORT_TYPES = new Set([
  'coep',
  'coop',
  'crash',
  'csp-violation',
  'deprecation',
  'document-policy-violation',
  'intervention',
  'permissions-policy-violation',
]);
const KEYWORDS = new Set([
  'inline',
  'eval',
  'wasm-eval',
  'trusted-types-policy',
  'trusted-types-sink',
]);
const PER_BATCH = 20;
const PER_MINUTE = 120;
const MINUTE = 60_000;

export type ReportLine = {
  type: string;
  directive?: string;
  blocked?: string;
  disposition?: string;
  path?: string;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Where something came from, without the part of a URL that can hold a secret. */
function blockedSource(value: string): string | undefined {
  if (KEYWORDS.has(value)) return value;
  try {
    return new URL(value).origin.slice(0, 120);
  } catch {
    return undefined;
  }
}

function pathOf(value: string): string | undefined {
  try {
    return new URL(value).pathname.slice(0, 120);
  } catch {
    return undefined;
  }
}

/** What may be logged of a posted batch; `null` when it is no batch at all. */
export function reportLines(batch: unknown): ReportLine[] | null {
  if (!Array.isArray(batch)) return null;
  const lines: ReportLine[] = [];
  for (const entry of batch.slice(0, PER_BATCH)) {
    const report = record(entry);
    const type = text(report['type']);
    if (!REPORT_TYPES.has(type)) continue;
    const body = record(report['body']);
    const directive = text(body['effectiveDirective']);
    const disposition = text(body['disposition']);
    const blocked = blockedSource(text(body['blockedURL']));
    const path = pathOf(text(report['url']));
    lines.push({
      type,
      ...(/^[a-z-]{1,40}$/.test(directive) ? { directive } : {}),
      ...(blocked ? { blocked } : {}),
      ...(disposition === 'enforce' || disposition === 'report' ? { disposition } : {}),
      ...(path ? { path } : {}),
    });
  }
  return lines;
}

/** Lets through at most `PER_MINUTE` lines per minute; `dropped` is what the last window lost. */
export function reportBudget(): { take(now: number): { allowed: boolean; dropped: number } } {
  let start = Number.NEGATIVE_INFINITY;
  let used = 0;
  let over = 0;
  return {
    take(now) {
      let dropped = 0;
      if (now - start >= MINUTE) {
        dropped = over;
        start = now;
        used = 0;
        over = 0;
      }
      if (used >= PER_MINUTE) {
        over += 1;
        return { allowed: false, dropped };
      }
      used += 1;
      return { allowed: true, dropped };
    },
  };
}
