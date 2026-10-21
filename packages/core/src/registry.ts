// The use-case registry (ADR 009): one list every front reads. packages/api turns it into HTTP
// routes and an OpenAPI document, packages/mcp into tools and resources, apps/web calls it from
// server actions. Adding a use case means adding one entry here; nothing else needs to know.
//
// Why not decorators or a plugin system: a plain array of typed objects is greppable, has no
// runtime magic, and an agent can list every operation in the system by reading this file.

import type { z } from 'zod';
import type { Capability, Principal } from './principal.js';
import type { TransactionContext } from './ports.js';

export type UseCaseKind = 'query' | 'command';

export interface UseCase<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Dotted, lowercase, stable: `content.page.create`. Becomes the MCP tool name and the OpenAPI operationId. */
  name: string;
  kind: UseCaseKind;
  /** One sentence for humans and agents. */
  description: string;
  requires: Capability;
  input: TInput;
  output: TOutput;
  handler: (ctx: TransactionContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}

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
    return (
      principal.capabilities.includes(useCase.requires) ||
      principal.capabilities.includes('tenant:admin')
    );
  }
}
