// Problem Details (RFC 9457) for every error the HTTP front returns. `type` is a stable URN per
// code so clients branch on it without parsing titles; `code` repeats it as a plain extension, the
// same value the MCP front puts in its error payload. Rejected: `about:blank` with the code in
// `title`, which the probe used and which leaves clients nothing stable to match.

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Issue, UseCaseErrorCode } from '@mycel/core';

export type ProblemCode = UseCaseErrorCode | 'unauthorized' | 'method_not_allowed' | 'internal';

export const PROBLEMS: Record<ProblemCode, { status: ContentfulStatusCode; title: string }> = {
  invalid_input: { status: 400, title: 'Invalid input' },
  unauthorized: { status: 401, title: 'Unauthorized' },
  forbidden: { status: 403, title: 'Forbidden' },
  not_found: { status: 404, title: 'Not found' },
  method_not_allowed: { status: 405, title: 'Method not allowed' },
  conflict: { status: 409, title: 'Conflict' },
  internal: { status: 500, title: 'Internal server error' },
};

export const problemType = (code: ProblemCode) => `urn:mycel:problem:${code}`;

export function problem(
  code: ProblemCode,
  detail?: string,
  issues: Issue[] = [],
  headers: Record<string, string> = {}
): Response {
  const { status, title } = PROBLEMS[code];
  const body = {
    type: problemType(code),
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    code,
    ...(code === 'invalid_input' ? { issues } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}
