export function selectBlockName(
  names: Record<string, string> | undefined,
  candidates: readonly Record<string, string>[],
  locale: string,
  fallback: string,
  file?: string
): { name: string; automatic: string };
