// Assistance depends on a model and tenant-owned records through ports. A worker invokes the
// model between two short units of work; no provider call can hold a database transaction open.

import type { z } from 'zod';

export type ModelFailure = 'unavailable' | 'timeout' | 'rejected' | 'invalid-output';

export class TextModelError extends Error {
  constructor(readonly failure: ModelFailure) {
    super(failure);
  }
}

export interface TextModel {
  describe(): { label: string; models: { text: string; vision: string } };
  complete(request: {
    task: 'alt' | 'translate';
    system: string;
    parts: readonly (
      { kind: 'text'; text: string } | { kind: 'image'; contentType: string; bytes: Uint8Array }
    )[];
    output: z.ZodTypeAny;
    maxTokens: number;
    signal: AbortSignal;
  }): Promise<{
    json: unknown;
    model: string;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}

export interface AssistSettings {
  enabled: boolean;
  allowRestricted: boolean;
  consentedProvider: string | null;
  consentedBy: string | null;
  consentedAt: Date | null;
}

export interface AssistSuggestion {
  id: string;
  itemId: string;
  baseRevisionId: string;
  blockId: string;
  locale: string;
  status: 'pending' | 'ready' | 'failed' | 'accepted' | 'dismissed';
  value: string | null;
  failure: ModelFailure | null;
  provider: string;
  requestedBy: string | null;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssistRepository {
  settings(): Promise<AssistSettings>;
  saveSettings(settings: AssistSettings): Promise<void>;
  /** Serialises quota checks against other requests for this tenant. */
  lockQuota(): Promise<void>;
  countSince(since: Date): Promise<number>;
  pendingCount(since: Date): Promise<number>;
  countByOperatorSince(operatorId: string, since: Date): Promise<number>;
  insert(suggestion: AssistSuggestion): Promise<void>;
  get(id: string): Promise<AssistSuggestion | null>;
  list(itemId: string): Promise<AssistSuggestion[]>;
  /** Only changes a pending row, so a late worker cannot undo an editor decision. */
  complete(
    id: string,
    patch: Pick<AssistSuggestion, 'status' | 'value' | 'failure' | 'model' | 'updatedAt'>
  ): Promise<boolean>;
  decide(id: string, status: 'accepted' | 'dismissed', at: Date): Promise<boolean>;
  deleteBefore(before: Date): Promise<number>;
}

declare module '../ports.js' {
  interface TransactionContext {
    assist: AssistRepository;
    /** Configured processor shown at consent time; null means no provider can run. */
    assistProviderLabel: string | null;
  }
}
