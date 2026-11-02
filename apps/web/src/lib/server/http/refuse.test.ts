// `refusalOf` decides what a route's catch treats as an answer and what stays a server failure, so
// a real failure must not turn into a form message.
import { UseCaseError } from '@mycel/core';
import { describe, expect, it } from 'vitest';
import { refusalOf } from './refuse.js';

describe('refusalOf', () => {
  it('hands back a use case refusal', () => {
    const refusal = new UseCaseError('suspended', 'suspended');
    expect(refusalOf(refusal)).toBe(refusal);
  });

  it('rethrows anything else as it was', () => {
    const failure = new Error('database gone');
    expect(() => refusalOf(failure)).toThrow(failure);
  });
});
