import { describe, expect, it } from 'vitest';
import { csvCell, csvFile } from './csv.js';

describe('csv', () => {
  it('quotes a comma, a quote and a line break, and doubles the quote', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(3)).toBe('3');
  });

  it('keeps a cell a spreadsheet would run as a formula as text', () => {
    expect(csvCell('=HYPERLINK("x")@example.org')).toBe(`"'=HYPERLINK(""x"")@example.org"`);
    for (const start of ['+', '-', '@', '\t'])
      expect(csvCell(`${start}1`).startsWith(`'${start}`)).toBe(true);
    // A negative number the code itself writes is a number, not a typed formula.
    expect(csvCell(-1)).toBe('-1');
  });

  it('ends every row, the header too, with CRLF', () => {
    expect(csvFile(['a', 'b'], [['1', '2']])).toBe('a,b\r\n1,2\r\n');
    expect(csvFile(['a'], [])).toBe('a\r\n');
  });
});
