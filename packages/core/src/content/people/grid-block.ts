// A grid stores references, never a copy of a person's profile. The two sources share one
// schema so native forms can preserve a selection while the editor switches to a group.
import { z } from 'zod';
import { exampleId } from '../../util/ids.js';
import type { BlockDefinition } from '../block-types.js';

export const PeopleGridProps = z
  .object({
    source: z.enum(['selection', 'group']).default('selection'),
    groupId: z.string().guid().nullable().default(null),
    people: z
      .array(z.object({ personId: z.string().guid() }).strict())
      .max(100)
      .default([]),
    columns: z.enum(['2', '3', '4']).default('3'),
    showRole: z.boolean().default(true),
    showBio: z.boolean().default(true),
    showContact: z.boolean().default(false),
  })
  .strict()
  .refine((p) => p.source !== 'group' || p.groupId !== null, 'content.people-grid.group-required')
  .refine(
    (p) => new Set(p.people.map((v) => v.personId)).size === p.people.length,
    'content.authors.duplicate'
  );

export const PEOPLE_GRID_IDS = { person: exampleId(0xa001), group: exampleId(0xa002) };
export const peopleGridDefinition: BlockDefinition<typeof PeopleGridProps, 1> = {
  version: 1,
  props: PeopleGridProps,
  fields: [
    { key: 'source', kind: 'choice', options: ['selection', 'group'] },
    { key: 'groupId', kind: 'reference', to: 'person_group', optional: 'null' },
    {
      key: 'people',
      kind: 'list',
      min: 0,
      max: 100,
      fields: [{ key: 'personId', kind: 'reference', to: 'person' }],
    },
    { key: 'columns', kind: 'choice', options: ['2', '3', '4'], initial: '3' },
    { key: 'showRole', kind: 'boolean' },
    { key: 'showBio', kind: 'boolean' },
    { key: 'showContact', kind: 'boolean' },
  ],
  variants: { source: ['selection', 'group'], columns: ['2', '3', '4'] },
  localized: () => [],
  references: (p) => [
    ...(p.groupId ? [{ type: 'person_group' as const, refId: p.groupId }] : []),
    ...p.people.map(({ personId }) => ({ type: 'person' as const, refId: personId })),
  ],
  examples: [
    {
      name: 'people-grid-selection',
      props: { people: [{ personId: PEOPLE_GRID_IDS.person }], columns: '2', showContact: true },
    },
    {
      name: 'people-grid-group',
      props: { source: 'group', groupId: PEOPLE_GRID_IDS.group, columns: '3' },
    },
    {
      name: 'people-grid-compact',
      props: {
        people: [{ personId: PEOPLE_GRID_IDS.person }],
        columns: '4',
        showBio: false,
        showRole: false,
      },
    },
  ],
};
