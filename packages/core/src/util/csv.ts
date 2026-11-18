// CSV as a spreadsheet opens it (RFC 4180): comma-separated, CRLF between rows, a cell quoted
// when it holds a comma, a quote or a line break, a quote doubled inside. A cell that a spreadsheet
// would run as a formula (one starting with `=`, `+`, `-`, `@`, a tab or a carriage return) gets
// a leading apostrophe, so an address like `=HYPERLINK(...)@example.org` that a visitor typed into
// a form stays text in the file an administrator opens (OWASP, CSV injection). Rejected: a CSV
// library (two functions, no parser needed) and stripping those characters (the file would no
// longer say what was stored).

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One cell, safe to open in a spreadsheet. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One row, without its line ending. */
export const csvRow = (cells: readonly (string | number | null | undefined)[]): string =>
  cells.map(csvCell).join(',');

/** A whole file: a header row and the rows, each ended by CRLF. */
export const csvFile = (
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[]
): string => [header, ...rows].map((r) => `${csvRow(r)}\r\n`).join('');
