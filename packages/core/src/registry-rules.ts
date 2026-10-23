// The registry's rules as code (testing.md, registry conformance): the conformance test runs them
// on the real registry, and a meta-test runs them on deliberately broken use cases so no rule is
// vacuous while the registry has no publish or send use case yet. Rejected: the same rules as
// assertions inside the test file, which cannot be shown to catch anything until a violation
// lands on main.

import { LimitName } from './entitlements/model.js';
import { describesObject, toJsonSchema } from './json-schema.js';
import { EFFECT_CAPABILITY, type UseCase, type UseCaseRegistry } from './registry.js';

const NAME = /^[a-z]+(\.[a-z][a-z_]*)+$/;

/** Last name segments that publish, send, export or refund, and so must declare an `effect`. */
const EFFECT_VERBS = ['publish', 'unpublish', 'schedule', 'unschedule', 'send', 'export', 'refund'];

/**
 * Editorial modules: every use case under these prefixes must be `authenticatedOnly`, so a
 * public visitor's `content:read` never opens a draft, a revision or an author's e-mail address.
 * The public projection (`content.published.get`) is outside them on purpose.
 */
const EDITORIAL_PREFIXES = [
  'content.item.',
  'content.author.',
  'content.section.',
  'content.pattern.',
];

/** Last name segments that make something new, and so must say which limit they consume. */
const GROWTH_VERBS = ['create', 'invite', 'add', 'submit', 'upload'];

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
  if (!description.trim()) fail('description is empty');
  else if (!description.trim().endsWith('.')) fail('description does not end with a full stop');

  // ADR 018 rule 5: publishing, sending, exporting and refunding need their own capability.
  if (effect) {
    if (kind === 'query') fail(`a query cannot have effect "${effect}"`);
    else if (requires !== EFFECT_CAPABILITY[effect])
      fail(`effect "${effect}" requires ${EFFECT_CAPABILITY[effect]}, not ${requires}`);
  }
  const verb = name.split('.').at(-1) ?? '';
  if (kind === 'command' && EFFECT_VERBS.includes(verb) && !effect)
    fail(`a command named "${verb}" must declare an effect`);

  // ADR 015: a limit is checked where it is consumed, and a growing command says which (or null).
  if (consumes !== undefined && consumes !== null && !LimitName.safeParse(consumes).success)
    fail(`consumes "${String(consumes)}", which is not a known limit`);
  if (consumes != null && kind === 'query') fail('a query cannot consume a limit');
  if (kind === 'command' && GROWTH_VERBS.includes(verb) && consumes === undefined)
    fail(`a command named "${verb}" must declare consumes (a limit, or null)`);

  if (EDITORIAL_PREFIXES.some((p) => name.startsWith(p)) && !useCase.authenticatedOnly)
    fail('an editorial use case must be authenticatedOnly');

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
