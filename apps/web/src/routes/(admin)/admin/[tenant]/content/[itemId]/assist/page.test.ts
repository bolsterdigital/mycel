// The assist page's states rendered with `svelte/server`, as the admin serves them without
// JavaScript (TODO #68). The pending state is a moment between the request and the worker's
// answer; in the browser e2e the fake provider can finish before the redirect renders, so the
// copy and the refresh of that state are proven here, where the state is a fixture.
// Rejected: pausing the worker in the e2e, which would add a test-only control to the job runner.
import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';
import { render } from 'svelte/server';
import Page from './+page.svelte';

const base = {
  adminLocale: 'nl',
  task: 'translate',
  source: 'Bronkop',
  value: '',
  revisionId: 'rev-1',
  itemId: 'item-1',
  locale: 'en',
  from: 'nl',
  to: 'en',
  target: 'title',
  block: null,
  stale: false,
  tenant: { slug: 'probe' },
  query: '&from=nl',
};

// The fixture is the load result's shape, not its generated type, so the page is widened here.
const Assist = Page as unknown as Component<{ data: object; form: null }>;

const page = (suggestion: object | null, locale = 'nl') => {
  const { head, body } = render(Assist, {
    props: { data: { ...base, adminLocale: locale, suggestion }, form: null },
  });
  return { head, body };
};

describe('assist page', () => {
  it('shows a pending suggestion as a status and refreshes itself, in nl and en', () => {
    const pending = { id: 's-1', status: 'pending', baseRevisionId: 'rev-1' };
    const nl = page(pending);
    expect(nl.body).toMatch(/<p role="status">[^<]*wordt gemaakt/);
    expect(nl.head).toContain('<meta http-equiv="refresh" content="3"');
    expect(nl.body).not.toContain('id="assist-value"');
    expect(page(pending, 'en').body).toMatch(/<p role="status">[^<]*being prepared/);
  });

  it('shows a ready suggestion as an editable proposal without status or refresh', () => {
    const ready = { id: 's-1', status: 'ready', value: '[en] Bronkop', baseRevisionId: 'rev-1' };
    const { head, body } = page(ready);
    expect(body).toContain('id="assist-value"');
    expect(body).not.toContain('role="status"');
    expect(head).not.toContain('http-equiv="refresh"');
  });
});
