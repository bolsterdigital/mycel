// Roles are names for known capability sets (#101). What a member or key
// may do stays the stored capability set that `grants` reads; a role is derived from it on every
// read and never stored. So there is no migration, no second truth, and nothing changes in what
// the Invoker checks. A set that matches no preset is `custom`, shown with its capabilities.
//
// Presets are ordered and nested (author ⊂ editor ⊂ admin), so a promotion never takes a right
// away; a test holds that. `admin` is any set holding `tenant:admin`, read the way `grants` reads
// it: the seed and the CLI store admins as `['tenant:admin']` alone, and a set with more next to
// it grants nothing extra. Rejected: exact set equality for admin too, which would show the first
// admin of every site as `custom`; and a stored role column, which could disagree with the set.
//
// "An author publishes their own work" does not exist yet: the model has no ownership. An author
// writes and edits all content and media and does not publish; an editor publishes too. When the
// editorial workflow comes (A5), `author` narrows without a rename.

import { z } from 'zod';
import { type Capability, grants } from '../principal.js';

export const Role = z.enum(['author', 'editor', 'admin', 'custom']);
export type Role = z.infer<typeof Role>;

/** The roles that name a capability set; `custom` is whatever matches none of them. */
export const PresetRole = Role.exclude(['custom']);
export type PresetRole = z.infer<typeof PresetRole>;

const AUTHOR: readonly Capability[] = [
  'content:read',
  'content:write',
  'media:read',
  'media:write',
  'ai:assist',
];
const EDITOR: readonly Capability[] = [
  ...AUTHOR,
  'content:publish',
  'forms:read',
  'supporters:read',
];

/** Ordered from least to most; each preset grants everything the one before it grants. */
export const ROLE_PRESETS: readonly { role: PresetRole; capabilities: readonly Capability[] }[] = [
  { role: 'author', capabilities: AUTHOR },
  { role: 'editor', capabilities: EDITOR },
  { role: 'admin', capabilities: ['tenant:admin'] },
];

/** An API key never holds `tenant:admin` (model.ts), so its presets stop at editor. */
export const KEY_ROLES: readonly PresetRole[] = ['author', 'editor'];

const sameSet = (a: readonly Capability[], b: readonly Capability[]) =>
  a.length === b.length && b.every((c) => a.includes(c));

/** The role a capability set amounts to, independent of order. */
export function roleFor(capabilities: readonly Capability[]): Role {
  if (grants(capabilities, 'tenant:admin')) return 'admin';
  const unique = [...new Set(capabilities)];
  return ROLE_PRESETS.find((p) => sameSet(unique, p.capabilities))?.role ?? 'custom';
}

/** The capability set a preset stands for, as a fresh array a use case input can take. */
export function capabilitiesFor(role: PresetRole): Capability[] {
  const preset = ROLE_PRESETS.find((p) => p.role === role);
  if (!preset) throw new Error(`unknown role ${role}`);
  return [...preset.capabilities];
}
