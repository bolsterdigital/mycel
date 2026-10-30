// The one code path every front uses to run a use case: look up, authorize, validate input, run
// inside a tenant-scoped unit of work, validate output. HTTP, MCP and the web app differ only in
// how they build the Principal and how they render the result or the UseCaseError.
//
// Output is validated inside the unit of work, so a handler that answers outside its schema rolls
// back what it wrote, events included. Rejected: parsing after commit, which reported a failure for
// a change that had already happened and whose outbox events would still be delivered.
//
// Every command leaves exactly one audit row (TODO #17b, brief observability-b-audit decision 2).
// A command that succeeds writes it in its own transaction, after the output is validated, so a
// rollback leaves no `ok` row; one that is refused or fails writes it in a short transaction of
// its own after the rollback, and the original error is rethrown unchanged. Queries are not
// audited. Rejected: a Postgres trigger (sees no principal and touches every table), auditing in
// the fronts (three places, one of them forgotten sooner or later), and always a separate
// transaction (a crash between the two commits leaves a change without its row).

import type { z } from 'zod';
import {
  auditActor,
  auditResult,
  auditSubject,
  hashInput,
  type AuditEntry,
} from './audit/model.js';
import './audit/ports.js';
import { requireActive } from './entitlements/guards.js';
import { type Issue, notFound, UseCaseError } from './errors.js';
import type { ErrorReporter, Logger, TransactionContext, UnitOfWork } from './ports.js';
import type { Principal } from './principal.js';
import type { UseCase, UseCaseRegistry } from './registry.js';

export function zodIssues(error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** What the Invoker needs besides the registry and the unit of work; every field is optional. */
export interface InvokerOptions {
  /** The request id of the surrounding front context (`currentContext()` of @mycel/observability). */
  requestId?: () => string | undefined;
  /** Where a failure to write a refusal's audit row goes; the original error still wins. */
  log?: Logger;
  errors?: ErrorReporter;
}

export class Invoker {
  constructor(
    readonly registry: UseCaseRegistry,
    private readonly uow: UnitOfWork,
    private readonly options: InvokerOptions = {}
  ) {}

  /** Untyped entry point for generic fronts (HTTP `POST /v1/<name>`, MCP tools). */
  async call(principal: Principal, name: string, input: unknown): Promise<unknown> {
    const useCase = this.registry.get(name);
    if (!useCase) throw notFound('operation', `the name "${name}"`);
    return this.run(useCase, principal, input);
  }

  /** Typed entry point for fronts that know which use case they call (the web app). */
  async run<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    useCase: UseCase<I, O>,
    principal: Principal,
    input: z.input<I>
  ): Promise<z.infer<O>> {
    if (useCase.kind !== 'command') {
      const parsed = admit(useCase as unknown as UseCase, this.registry, principal, input);
      return this.uow.run(principal, async (ctx) =>
        useCase.output.parse(await useCase.handler(ctx, parsed as z.infer<I>))
      ) as Promise<z.infer<O>>;
    }
    const requestId = this.options.requestId?.() ?? null;
    // What the row hashes: the raw input until it parses, the parsed input after.
    let hashed: unknown = input;
    try {
      const parsed = admit(useCase as unknown as UseCase, this.registry, principal, input);
      hashed = parsed;
      return (await this.uow.run(principal, async (ctx) => {
        const output = useCase.output.parse(await useCase.handler(ctx, parsed as z.infer<I>));
        await ctx.audit.record(
          await auditEntry(ctx, useCase as unknown as UseCase, parsed, 'ok', requestId, output)
        );
        return output;
      })) as z.infer<O>;
    } catch (error) {
      await this.#recordFailure(useCase as unknown as UseCase, principal, hashed, error, requestId);
      throw error;
    }
  }

  /** The refusal's or failure's row, in a transaction of its own; never replaces `error`. */
  async #recordFailure(
    useCase: UseCase,
    principal: Principal,
    input: unknown,
    error: unknown,
    requestId: string | null
  ): Promise<void> {
    const result = auditResult(error);
    try {
      await this.uow.run(principal, async (ctx) =>
        ctx.audit.record(await auditEntry(ctx, useCase, input, result, requestId))
      );
    } catch (auditError) {
      this.options.log?.error('audit: could not record a command', {
        operation: useCase.name,
        result,
        tenantId: principal.tenantId,
      });
      this.options.errors?.capture(auditError, {
        tenantId: principal.tenantId,
        requestId: requestId ?? undefined,
        tags: { operation: useCase.name },
      });
    }
  }
}

/** Suspension, authorization and input validation, in that order; the parsed input. */
function admit(
  useCase: UseCase,
  registry: UseCaseRegistry,
  principal: Principal,
  input: unknown
): unknown {
  guardSuspended(useCase, principal);
  if (!registry.authorize(useCase, principal))
    throw new UseCaseError('forbidden', `missing capability ${useCase.requires}`);
  const parsed = useCase.input.safeParse(input);
  if (!parsed.success)
    throw new UseCaseError(
      'invalid_input',
      'input does not match the schema',
      zodIssues(parsed.error)
    );
  return parsed.data;
}

async function auditEntry(
  ctx: TransactionContext,
  useCase: UseCase,
  input: unknown,
  result: string,
  requestId: string | null,
  output?: unknown
): Promise<AuditEntry> {
  const actor = auditActor(ctx.principal.actor);
  return {
    id: ctx.ids.next(),
    tenantId: ctx.principal.tenantId,
    occurredAt: ctx.clock.now(),
    actorKind: actor.kind,
    actorId: actor.id,
    operation: useCase.name,
    effect: useCase.effect ?? null,
    inputHash: await hashInput(ctx.inputHasher, input),
    result,
    requestId,
    subjectId: auditSubject(output),
  };
}

/**
 * ADR 015 rule 7: a suspended tenant runs queries (the public site stays readable, the admin
 * stays open) and export commands (ADR 002 rule 5: leaving is never gated), and nothing else.
 * Checked before authorization, so every front and every use case gets it from this one line.
 */
export function guardSuspended(useCase: UseCase, principal: Principal): void {
  if (useCase.kind === 'command' && useCase.effect !== 'export') requireActive(principal);
}
