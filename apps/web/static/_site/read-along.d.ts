export const CAPTION_MODES: readonly ['showing', 'hidden', 'disabled'];
export function clockTime(seconds: number): string;
export function momentOf(search: string): number | null;
export function lineAt(starts: readonly number[], time: number): number;
export function findMatches(
  texts: readonly string[],
  query: string
): { line: number; start: number; end: number }[];
export function shareUrl(href: string, seconds: number): string;
