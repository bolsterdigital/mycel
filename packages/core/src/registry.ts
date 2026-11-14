// The use-case registry (ADR 009): one list every front reads. packages/api turns it into HTTP
// routes and an OpenAPI document, packages/mcp into tools and resources, apps/web calls it from
// server actions. Adding a use case means adding one entry here; nothing else needs to know.
//
// Why not decorators or a plugin system: a plain array of typed objects is greppable, has no
// runtime magic, and an agent can list every operation in the system by reading this file.

import type { z } from 'zod';
import type { LimitName } from './entitlements/model.js';
import type { Capability, Principal } from './principal.js';
import type { TransactionContext } from './ports.js';

export type UseCaseKind = 'query' | 'command';

/**
 * What a command does beyond writing (ADR 018 rule 5). Each effect has exactly one capability, so
 * "improve this text" can never imply "mail everyone"; `registry-rules.ts` enforces the pairing.
 * The `effect` check of `audit_log` (migration 0015) mirrors this list: a new effect needs a
 * migration before any command carries it, or its audit row is refused.
 */
export type UseCaseEffect = 'publish' | 'send' | 'export' | 'refund' | 'erase';

export const EFFECT_CAPABILITY: Record<UseCaseEffect, Capability> = {
  publish: 'content:publish',
  send: 'mailing:send',
  export: 'supporters:export',
  refund: 'money:refund',
  /** ADR 019 rule 8 with ADR 032: an erasure cannot be undone (migration 0047). */
  erase: 'supporters:erase',
};

/** A valid input with an optional note; the conformance suites run every front against it. */
export interface UseCaseExample<TInput = unknown> {
  input: TInput;
  note?: string;
}

export interface UseCase<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Dotted, lowercase, stable: `content.item.create`. Becomes the MCP tool name and the OpenAPI operationId. */
  name: string;
  kind: UseCaseKind;
  /** One sentence for humans and agents. */
  description: string;
  requires: Capability;
  /**
   * Capabilities needed beside `requires`, for a use case that does the work of several in one
   * transaction (ADR 033 rule 10: `campaign.landing.create` also makes a form, which needs
   * `forms:write` and, for a petition or signup, `content:publish`). `authorize` checks them, so
   * every front refuses the same principal before the handler runs, and OpenAPI names them.
   * Rejected: checks inside the handler only (the front-door contract would understate what the
   * call needs, and the conformance suites could not grant exactly enough).
   */
  alsoRequires?: readonly Capability[];
  effect?: UseCaseEffect;
  /**
   * The limit this use case grows (ADR 015): it must call `withinLimit` for it, and the registry
   * conformance proves that by running `examples[0]` with that limit at zero. `null` says "grows
   * nothing countable", which a command named create, invite, add, submit or upload must say
   * explicitly (`registry-rules.ts`), so forgetting a limit cannot pass unnoticed.
   */
  consumes?: LimitName | null;
  /** An API key or agent cannot truthfully claim a human editorial decision. */
  actors?: readonly Principal['actor']['kind'][];
  input: TInput;
  output: TOutput;
  handler: (ctx: TransactionContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
  /**
   * Queries that address one thing can also be an MCP resource (ADR 009 rule 8). Template
   * variables map one-to-one to input fields: `mycel://published/{type}/{slug}` reads `{ type, slug }`.
   */
  resource?: { uriTemplate: string };
  /**
   * At least one valid input (testing.md rule 1). The registry conformance suites in core, api and
   * mcp run every front against `examples[0]`, so a new use case is tested without a new test.
   */
  examples: readonly [UseCaseExample<z.input<TInput>>, ...UseCaseExample<z.input<TInput>>[]];
}

/**
 * The only use cases an anonymous principal reaches, whatever capabilities it carries: what a
 * public page reads and the visitor's own form and opt-in. Everything else is refused, so a new use
 * case is closed until someone adds it here. Rejected: a flag on each use case that closes it,
 * because forgetting the flag then opens it, and resting on the front, which a next front need not
 * repeat.
 */
export const ANONYMOUS_USE_CASES: ReadonlySet<string> = new Set([
  // A campaign card on a public page (ADR 033 rule 4): only published, public landing pages and
  // aggregates; the reason a card is empty is no more than the page itself already withholds.
  'campaign.card.get',
  'content.published.get',
  // Title and an excerpt of public, indexable published revisions only; restricted
  // items are left out whole.
  'content.published.find',
  // Addresses and publication facts of published locales only, no document text.
  'content.published.list',
  'content.public_person.get',
  'content.public_person.list',
  'form.get',
  'form.submit',
  'mailing.opt_in.confirm',
  'mailing.opt_in.get',
  'media.get',
  'site.brand.get',
  'site.chrome.get',
  'site.general.get',
  'site.theme.get',
]);

/**
 * The commands that write no audit row (ADR 029 rule 3), closed like `ANONYMOUS_USE_CASES`: a new
 * command is audited until someone adds it here, and the registry rules refuse an entry with an
 * effect or a limit. Rejected: a flag on each use case, where a copied flag goes unnoticed.
 */
export const UNAUDITED_COMMANDS: ReadonlySet<string> = new Set(['content.presence.update']);

export function defineUseCase<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  useCase: UseCase<TInput, TOutput>
): UseCase<TInput, TOutput> {
  return useCase;
}

export class UseCaseRegistry {
  readonly #cases = new Map<string, UseCase>();

  register(useCase: UseCase): this {
    if (this.#cases.has(useCase.name))
      throw new Error(`use case already registered: ${useCase.name}`);
    this.#cases.set(useCase.name, useCase);
    return this;
  }

  get(name: string): UseCase | undefined {
    return this.#cases.get(name);
  }

  list(): UseCase[] {
    return [...this.#cases.values()];
  }

  /** Authorization check shared by every front, so no front can forget it. */
  authorize(useCase: UseCase, principal: Principal): boolean {
    if (principal.actor.kind === 'anonymous' && !ANONYMOUS_USE_CASES.has(useCase.name))
      return false;
    if (useCase.actors && !useCase.actors.includes(principal.actor.kind)) return false;
    if (principal.capabilities.includes('tenant:admin')) return true;
    return requiredCapabilities(useCase).every((c) => principal.capabilities.includes(c));
  }
}

/** Every capability a use case needs: `requires`, then `alsoRequires`. */
export const requiredCapabilities = (useCase: UseCase): Capability[] => [
  useCase.requires,
  ...(useCase.alsoRequires ?? []),
];
