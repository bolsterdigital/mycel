import { describe, expect, it } from 'vitest';
import { UseCaseError } from '@mycel/core';
import { failureOf, type ActionCopy } from './admin-actions.js';

const copy: ActionCopy = {
  conflict: 'admin.content.delete.referenced',
  invalid: 'admin.content.error.invalid',
  issues: {
    'content.delete.campaign-landing': 'admin.content.delete.campaignLanding',
    'content.slug.taken': 'admin.content.error.slugTaken',
  },
};

const refusal = (code: UseCaseError['code'], key: string) =>
  new UseCaseError(code, 'refused', [{ path: 'itemId', message: key }]);

describe('failureOf', () => {
  it('gives a conflict the issue line for its key', () => {
    expect(
      failureOf(refusal('conflict', 'content.delete.campaign-landing'), 'delete', copy)
    ).toEqual({
      status: 409,
      body: { action: 'delete', error: 'admin.content.delete.campaignLanding' },
    });
  });

  it('keeps the conflict copy for a key without an issue line', () => {
    expect(failureOf(refusal('conflict', 'content.delete.referenced'), 'delete', copy)).toEqual({
      status: 409,
      body: { action: 'delete', error: 'admin.content.delete.referenced' },
    });
    expect(
      failureOf(refusal('conflict', 'content.delete.campaign-landing'), 'delete', {
        conflict: 'admin.content.delete.referenced',
      }).body.error
    ).toBe('admin.content.delete.referenced');
  });

  it('maps invalid input as before: issue line, then invalid, then the general sentence', () => {
    expect(failureOf(refusal('invalid_input', 'content.slug.taken'), 'save', copy).body).toEqual({
      action: 'save',
      error: 'admin.content.error.slugTaken',
    });
    expect(failureOf(refusal('invalid_input', 'other.key'), 'save', copy).body.error).toBe(
      'admin.content.error.invalid'
    );
    expect(
      failureOf(refusal('invalid_input', 'other.key'), 'save', {
        conflict: 'admin.content.delete.referenced',
      })
    ).toEqual({ status: 400, body: { action: 'save', error: 'admin.error.invalid' } });
  });

  it('leaves a limit and a suspension to their own copy, whatever the issue lines say', () => {
    const lines: ActionCopy = {
      ...copy,
      issues: {
        'entitlements.limit.supporters.max': 'admin.content.delete.campaignLanding',
        'tenant.suspended': 'admin.content.delete.campaignLanding',
      },
    };
    expect(
      failureOf(refusal('limit_exceeded', 'entitlements.limit.supporters.max'), 'add', lines)
    ).toEqual({
      status: 403,
      body: { action: 'add', error: 'admin.limit.reached', what: 'admin.limit.what.supporters' },
    });
    expect(failureOf(refusal('suspended', 'tenant.suspended'), 'add', lines)).toEqual({
      status: 403,
      body: { action: 'add', error: 'admin.error.suspended' },
    });
  });

  it('keeps forbidden and not found on their own copy', () => {
    expect(failureOf(refusal('forbidden', 'content.slug.taken'), 'save', copy).body.error).toBe(
      'admin.error.forbidden'
    );
    expect(failureOf(refusal('not_found', 'content.slug.taken'), 'save', copy).body.error).toBe(
      'admin.error.notFound'
    );
  });
});
