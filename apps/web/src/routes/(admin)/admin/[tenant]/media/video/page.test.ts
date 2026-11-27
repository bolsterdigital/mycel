// Render the action result with the reloaded draft: a core version check alone cannot
// tell whether the editor saw the text belonging to the publication form.
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { expect, it } from 'vitest';
import Page from './+page.svelte';

const Video = Page as unknown as Component<{ data: object; form: object | null }>;
const transcript = {
  id: 'video-1',
  language: 'nl',
  source: 'Saved draft B',
  chapters: '0:00 Opening B',
  version: 'version-B',
  published: false,
};
const data = {
  locale: 'nl',
  tenant: { slug: 'probe', name: 'Probe', locales: ['nl'], defaultLocale: 'nl' },
  videos: [],
  transcript,
  canPublish: true,
};

it('preserves the rejected text and its base without offering the unseen saved draft for publication', () => {
  const form = {
    ok: false,
    error: 'admin.video.transcript.conflict',
    source: 'Rejected draft A',
    chapters: '0:00 Rejected chapters A',
    version: 'version-A',
    id: transcript.id,
    language: transcript.language,
  };
  const { body } = render(Video, { props: { data, form } });
  expect(body).toContain('Rejected draft A</textarea>');
  // The chapters belong to the same draft and version (MY-305): the rejected ones stay too.
  expect(body).toContain('0:00 Rejected chapters A</textarea>');
  expect(body).toContain('name="version" value="version-A"');
  expect(body).not.toContain('?/publishTranscript');
});

it.each([null, { ok: true, saved: true }])(
  'publishes the visible saved draft after opening or saving it (%j)',
  (form) => {
    const { body } = render(Video, { props: { data, form } });
    expect(body).toContain('Saved draft B</textarea>');
    expect(body).toContain('0:00 Opening B</textarea>');
    expect(body.match(/<form[^>]*\?\/publishTranscript[^>]*>[\s\S]*?<\/form>/)?.[0]).toContain(
      'name="version" value="version-B"'
    );
  }
);

it('shows the saved chapters after a refused publication, which posts none', () => {
  const form = { ok: false, error: 'admin.video.transcript.conflict', source: '', version: 'v' };
  const { body } = render(Video, { props: { data, form } });
  expect(body).toContain('0:00 Opening B</textarea>');
});
