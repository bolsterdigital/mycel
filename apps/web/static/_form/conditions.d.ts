import type { FieldPredicate, FormField } from '@mycel/core';
export function matches(
  predicate: FieldPredicate,
  values: Record<string, string | boolean | number | string[]>
): boolean;
export function enhance(form: HTMLFormElement): void;
