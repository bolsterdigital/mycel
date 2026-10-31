import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '@mycel/core';
import { postedCapabilities } from './roles.js';

const form = (entries: [string, string][]) => {
  const data = new FormData();
  for (const [k, v] of entries) data.append(k, v);
  return data;
};

describe('postedCapabilities', () => {
  it('turns a chosen preset into its capabilities and ignores stray ticks', () => {
    const data = form([
      ['role', 'editor'],
      ['capabilities', 'tenant:admin'],
    ]);
    expect(postedCapabilities(data)).toEqual(capabilitiesFor('editor'));
  });

  it('reads the ticks for custom and for a post without a role', () => {
    const ticks: [string, string][] = [
      ['capabilities', 'content:read'],
      ['capabilities', 'forms:read'],
    ];
    expect(postedCapabilities(form([['role', 'custom'], ...ticks]))).toEqual([
      'content:read',
      'forms:read',
    ]);
    expect(postedCapabilities(form(ticks))).toEqual(['content:read', 'forms:read']);
  });
});
