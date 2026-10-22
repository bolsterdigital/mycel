// The one code path every front uses to run a use case: look up, authorize, validate input, run
// inside a tenant-scoped unit of work, validate output. HTTP, MCP and the web app differ only in
// how they build the Principal and how they render the result or the UseCaseError.
//
// Output is validated inside the unit of work, so a handler that answers outside its schema rolls
// back what it wrote, events included. Rejected: parsing after commit, which reported a failure for
// a change that had already happened and whose outbox events would still be delivered.

import type { z } from 'zod';
import { UseCaseError, type Issue } from './errors.js';
import type { UnitOfWork } from './ports.js';
import type { Principal } from './principal.js';
import type { UseCase, UseCaseRegistry } from './registry.js';

export function zodIssues(error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export class Invoker {
  constructor(
    readonly registry: UseCaseRegistry,
    private readonly uow: UnitOfWork
  ) {}

  /** Untyped entry point for generic fronts (HTTP `POST /v1/<name>`, MCP tools). */
  async call(principal: Principal, name: string, input: unknown): Promise<unknown> {
    const useCase = this.registry.get(name);
    if (!useCase) throw new UseCaseError('not_found', `unknown operation "${name}"`);
    return this.run(useCase, principal, input);
  }

  /** Typed entry point for fronts that know which use case they call (the web app). */
  async run<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    useCase: UseCase<I, O>,
    principal: Principal,
    input: z.input<I>
  ): Promise<z.infer<O>> {
    if (!this.registry.authorize(useCase as unknown as UseCase, principal))
      throw new UseCaseError('forbidden', `missing capability ${useCase.requires}`);
    const parsed = useCase.input.safeParse(input);
    if (!parsed.success)
      throw new UseCaseError(
        'invalid_input',
        'input does not match the schema',
        zodIssues(parsed.error)
      );
    return this.uow.run(principal, async (ctx) =>
      useCase.output.parse(await useCase.handler(ctx, parsed.data))
    ) as Promise<z.infer<O>>;
  }
}
