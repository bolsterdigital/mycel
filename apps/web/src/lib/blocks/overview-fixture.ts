// What the block conformance suite's overview reads: two published articles in the asked locale,
// the first pinned when the block pins one, and a further page when the block keeps an archive;
// for an agenda two events, the first with an end and a place, the second online. Which items a
// real list returns is packages/db/src/adapter-rules.test.ts; this fixture proves only how a list
// renders. In a file of its own because the suite stands at its size ceiling.
import { EXAMPLE_IDS, exampleId, type BlockProps, type Overview } from '@mycel/core';

export function overviewFixture(props: BlockProps<'overview'>, locale: string): Overview {
  const event = (n: number) =>
    props.source !== 'event'
      ? null
      : {
          startsAt: `2026-12-0${n}T20:00`,
          endsAt: n === 1 ? '2026-12-01T22:00' : null,
          location: n === 1 ? (locale === 'nl' ? 'Buurthuis' : 'Community centre') : null,
          onlineUrl: n === 1 ? null : 'https://example.org/live',
          timeZone: 'Europe/Amsterdam',
        };
  const entry = (n: number, pinned: boolean) => ({
    id: exampleId(0xe000 + n),
    type: props.source === 'article' ? ('article' as const) : ('page' as const),
    slug: locale === 'nl' ? `bericht-${n}` : `post-${n}`,
    revisionId: exampleId(0xe100 + n),
    date: `2026-11-0${n}T10:00:00.000Z`,
    title: locale === 'nl' ? `Bericht ${n}` : `Post ${n}`,
    summary: locale === 'nl' ? `Samenvatting ${n}.` : `Summary ${n}.`,
    imageId: n === 1 ? EXAMPLE_IDS.image : null,
    event: event(n),
    pinned,
    // The second is for members (an agenda leaves those out): the card names it.
    restricted: n === 2 && props.source !== 'event',
  });
  return { entries: [entry(1, props.pinned.length > 0), entry(2, false)], older: props.archive };
}
