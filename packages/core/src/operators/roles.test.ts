// Roles as presets over capability sets (#101): nested, derived independent of order, admin read
// the way `grants` reads it, and a key preset never reaches tenant:admin.
import { describe, expect, it } from 'vitest';
import { Capability, grants } from '../principal.js';
import { KeyCapability } from './model.js';
import { capabilitiesFor, KEY_ROLES, PresetRole, ROLE_PRESETS, roleFor } from './roles.js';

describe('roles', () => {
  it('nests every preset in the next one, so a promotion never takes a right away', () => {
    for (let i = 1; i < ROLE_PRESETS.length; i += 1) {
      const lower = ROLE_PRESETS[i - 1]!.capabilities;
      const higher = ROLE_PRESETS[i]!.capabilities;
      for (const c of lower)
        expect(grants(higher, c), `${c} in ${ROLE_PRESETS[i]!.role}`).toBe(true);
      expect(Capability.options.some((c) => grants(higher, c) && !grants(lower, c))).toBe(true);
    }
  });

  it('round-trips every preset and ignores order and repeats', () => {
    for (const role of PresetRole.options) {
      expect(roleFor(capabilitiesFor(role))).toBe(role);
      expect(roleFor([...capabilitiesFor(role)].reverse())).toBe(role);
    }
    expect(roleFor([...capabilitiesFor('author'), 'content:read'])).toBe('author');
  });

  it('reads any set with tenant:admin as admin, like grants does', () => {
    expect(roleFor(['tenant:admin'])).toBe('admin');
    expect(roleFor(['content:read', 'tenant:admin'])).toBe('admin');
    expect(roleFor(Capability.options)).toBe('admin');
  });

  it('calls a set that matches no preset custom', () => {
    expect(roleFor(['content:read'])).toBe('custom');
    expect(roleFor([...capabilitiesFor('author'), 'forms:read'])).toBe('custom');
    expect(roleFor([])).toBe('custom');
  });

  it('gives a key a preset only below admin', () => {
    expect(KEY_ROLES).not.toContain('admin');
    for (const role of KEY_ROLES)
      for (const c of capabilitiesFor(role)) expect(KeyCapability.safeParse(c).success).toBe(true);
  });

  it('hands out a fresh array, so a caller cannot change a preset', () => {
    capabilitiesFor('author').push('tenant:admin');
    expect(roleFor(capabilitiesFor('author'))).toBe('author');
  });
});
