// The registry's rules as code (testing.md, registry conformance): the conformance test runs them
// on the real registry, and a meta-test runs them on deliberately broken use cases so no rule is
// vacuous while the registry has no publish or send use case yet. Rejected: the same rules as
// assertions inside the test file, which cannot be shown to catch anything until a violation
// lands on main.

import { LimitName } from './entitlements/model.js';
import { describesObject, toJsonSchema } from './json-schema.js';
import {
  EFFECT_CAPABILITY,
  UNAUDITED_COMMANDS,
  type UseCase,
  type UseCaseRegistry,
} from './registry.js';

const NAME = /^[a-z]+(\.[a-z][a-z_]*)+$/;

/** Last name segments that publish, send, export, refund or erase: they must declare an `effect`. */
const EFFECT_VERBS = [
  'publish',
  'unpublish',
  'schedule',
  'unschedule',
  'send',
  'export',
  'refund',
  'erase',
];

/** Last name segments that make something new, and so must say which limit they consume. */
const GROWTH_VERBS = ['create', 'duplicate', 'invite', 'add', 'submit', 'upload'];

/**
 * The naming rule (docs/reference/use-cases.md, TODO #54): `<module>.<entity>.<verb>`, or
 * `<module>.<verb>` when the module is the entity. A name is an HTTP path, an MCP tool and an
 * OpenAPI operation at once, so one word per concept, singular. `site` is the only prefix for site
 * settings, `tenant` the one for members, keys, hostnames, exports and limits. Rejected: a regex
 * alone, which cannot tell `connections` from `connection` or `put` from `update`.
 */
const MODULES = [
  'assist',
  'attention',
  'audit',
  // ADR 033 rule 12: a bare campaign is the participation entity; a mailing send is not one.
  'campaign',
  'connection',
  'content',
  'form',
  'mailing',
  'media',
  'ops',
  'site',
  'supporter',
  'tenant',
];

/** Entities that end in an s and are still singular: one document per tenant. */
const SINGULAR_DOCUMENTS = ['settings', 'entitlements', 'status'];

/**
 * The verbs a name may end in. Beyond the five plain ones each verb is a domain operation the
 * plain ones would misname: `remove` undoes `add`, `invite` or `insert` (the thing outlives its
 * place), `delete` undoes `create` or `upload` (the thing stops existing).
 */
const VERBS = [
  'duplicate',
  ...['create', 'get', 'list', 'update', 'delete'],
  // Placement in a collection: a tenant's hostnames and members, a document's blocks (ADR 020).
  ...['add', 'remove', 'invite', 'insert', 'move', 'split_insert', 'set_primary'],
  // ADR 018 effects and the editorial queries beside them.
  ...EFFECT_VERBS,
  ...['find', 'diff', 'approve'],
  // Suggestions (ADR 021), connections and intents (ADR 024), jobs (ops).
  ...['suggest', 'accept', 'dismiss', 'test', 'pause', 'resume', 'disconnect', 'replay', 'resolve'],
  ...['retry', 'close'],
  // ADR 025 rule 5: a hero's move into the document header, and what it would do.
  ...['convert', 'propose'],
  // Offering a locale for publication, and taking the offer back.
  ...['request', 'withdraw'],
  // Back out of the trash.
  'restore',
  // ADR 033 rules 2 and 9: participation opens (`close` is above) and a campaign is archived,
  // never deleted.
  ...['open', 'archive'],
  // A key, a hostname, a visitor's entry points, a theme report.
  ...['revoke', 'verify', 'upload', 'submit', 'confirm', 'check'],
];

function checkVocabulary(name: string, fail: (rule: string) => void): void {
  const segments = name.split('.');
  const [module = '', entity = ''] = segments;
  const verb = segments.at(-1) ?? '';
  if (segments.length > 3) fail('name has more than three segments');
  if (!MODULES.includes(module)) fail(`module "${module}" is not in MODULES`);
  if (!VERBS.includes(verb)) fail(`verb "${verb}" is not in VERBS`);
  if (segments.length === 3 && entity.endsWith('s') && !SINGULAR_DOCUMENTS.includes(entity))
    fail(`entity "${entity}" is plural`);
}

/** Returns every violation as one line naming the use case; an empty list means conformant. */
export function checkRegistry(registry: Pick<UseCaseRegistry, 'list'>): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const useCase of registry.list()) {
    const fail = (rule: string) => violations.push(`${useCase.name}: ${rule}`);
    checkUseCase(useCase, fail);
    if (seen.has(useCase.name)) fail('name is not unique');
    seen.add(useCase.name);
  }
  return violations;
}

function checkUseCase(useCase: UseCase, fail: (rule: string) => void): void {
  const { name, kind, description, requires, effect, consumes, examples } = useCase;

  if (!NAME.test(name)) fail(`name does not match ${NAME}`);
  else checkVocabulary(name, fail);
  if (!description.trim()) fail('description is empty');
  else if (!description.trim().endsWith('.')) fail('description does not end with a full stop');

  // ADR 018 rule 5: publishing, sending, exporting and refunding need their own capability. Or
  // `tenant:admin`, which holds every capability and is never weaker: `tenant.export.create` (TODO #28)
  // hands over members and the audit log, more than `supporters:export` covers.
  if (effect) {
    if (kind === 'query') fail(`a query cannot have effect "${effect}"`);
    else if (requires !== EFFECT_CAPABILITY[effect] && requires !== 'tenant:admin')
      fail(`effect "${effect}" requires ${EFFECT_CAPABILITY[effect]}, not ${requires}`);
  }
  // `alsoRequires` adds capabilities; it never repeats `requires` or names `tenant:admin`, which
  // would make the use case an admin's alone without saying so in `requires`.
  const also = useCase.alsoRequires ?? [];
  if (also.includes(requires) || also.includes('tenant:admin') || new Set(also).size < also.length)
    fail('alsoRequires repeats a capability or names tenant:admin');
  const verb = name.split('.').at(-1) ?? '';
  if (kind === 'command' && EFFECT_VERBS.includes(verb) && !effect)
    fail(`a command named "${verb}" must declare an effect`);

  // ADR 029 rule 3: only a command that leaves nothing behind may go without an audit row.
  if (UNAUDITED_COMMANDS.has(name) && (kind !== 'command' || effect || consumes != null))
    fail('an unaudited use case must be a command without an effect or a limit');

  // ADR 015: a limit is checked where it is consumed, and a growing command says which (or null).
  if (consumes !== undefined && consumes !== null && !LimitName.safeParse(consumes).success)
    fail(`consumes "${String(consumes)}", which is not a known limit`);
  if (consumes != null && kind === 'query') fail('a query cannot consume a limit');
  if (kind === 'command' && GROWTH_VERBS.includes(verb) && consumes === undefined)
    fail(`a command named "${verb}" must declare consumes (a limit, or null)`);

  if (
    useCase.actors &&
    (!useCase.actors.length || new Set(useCase.actors).size !== useCase.actors.length)
  )
    fail('actors must be a nonempty list without duplicates');

  // testing.md rule 1: a registry entry without a fixture fails verify.
  if (!Array.isArray(examples) || examples.length === 0) fail('has no examples');
  else
    examples.forEach((example, i) => {
      const parsed = useCase.input.safeParse(example.input);
      if (!parsed.success)
        fail(
          `examples[${i}] does not match the input schema: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
            .join('; ')}`
        );
    });

  // Every front describes input and output as JSON Schema; MCP needs both to be objects.
  for (const io of ['input', 'output'] as const) {
    try {
      const schema = toJsonSchema(useCase[io], io);
      if (io === 'input' ? schema.type !== 'object' : !describesObject(schema))
        fail(`${io} is not an object schema`);
    } catch (e) {
      fail(`${io} does not convert to JSON Schema: ${(e as Error).message}`);
    }
  }
}
