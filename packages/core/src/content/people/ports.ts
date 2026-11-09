// A group's ordered membership is written atomically with its optimistic base.
// Rejected: independent member writes that could commit a partial replacement.
import type { PersonGroup } from './model.js';

export interface PersonGroupRepository {
  get(id: string): Promise<PersonGroup | null>;
  list(offset: number, limit: number): Promise<PersonGroup[]>;
  insert(group: PersonGroup): Promise<void>;
  update(group: PersonGroup, baseUpdatedAt: string): Promise<boolean>;
}
declare module '../../ports.js' {
  interface TransactionContext {
    personGroups: PersonGroupRepository;
  }
}
