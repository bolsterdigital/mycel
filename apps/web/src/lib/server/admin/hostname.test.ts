import { describe, expect, it } from 'vitest';
import { pastedHostname } from './hostname.js';

describe('pastedHostname', () => {
  it('keeps a plain hostname, lower-cased', () => {
    expect(pastedHostname('www.Example.org')).toBe('www.example.org');
    expect(pastedHostname('bücher.example')).toBe('bücher.example');
  });

  it('drops what a pasted URL brings along', () => {
    expect(pastedHostname(' https://www.example.org/ ')).toBe('www.example.org');
    expect(pastedHostname('http://example.org:8080/path?q=1#top')).toBe('example.org');
    expect(pastedHostname('https://user:pw@example.org')).toBe('example.org');
    expect(pastedHostname('example.org/about')).toBe('example.org');
    expect(pastedHostname('example.org:')).toBe('example.org');
  });

  it('leaves what is not a hostname for the use case to refuse', () => {
    expect(pastedHostname('')).toBe('');
    expect(pastedHostname('not a host')).toBe('notahost');
  });
});
