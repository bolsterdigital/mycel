// Types for spec-check.mjs, so the e2e spec that runs the rules is typechecked
// (apps/web/e2e/tsconfig.json). Rejected: allowJs over scripts/, which would typecheck every
// quality script under the stricter workspace rules at once.
export type Role = 'page' | 'missing' | 'revalidation' | 'asset' | 'font' | 'negotiation';
export interface Sample {
  role: Role;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  https?: boolean;
  locale?: string;
}
export interface Rule {
  roles: Role[];
  check: (sample: Sample) => string | null;
}
export const RULES: Record<string, Rule>;
export function specFailures(
  checklist: { items: Record<string, { status: string; rule?: string }> },
  samples: Sample[]
): string[];
