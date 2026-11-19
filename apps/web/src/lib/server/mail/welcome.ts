// Welcome mails in the admin (MY-258 PR 2): one row per list on the overview, one form per list.
// Core holds the rules (`mailing.automation.list|update|test`): who may see, who may change, which
// items may be mailed, two steps on one day. This file only gathers what the screens show and
// reads the form, which always has five step rows; an empty row is no step, so a series grows and
// shrinks without JavaScript and without add and remove buttons.
// Rejected: a row per step with add and remove posts (three round trips to make a three-step
// series, each a half-made series in between), and an item picker that searches (a site with a
// welcome series has a handful of pages to choose from; the select lists the newest hundred).

import { can, MAX_AUTOMATION_STEPS, pickAny, useCases, type Principal } from '@mycel/core';
import { runtime } from '../runtime.js';
import { signupLists } from './newsletter.js';
import type { UiKey } from '../../../i18n/index.js';

/** A series as `mailing.automation.list` returns it. */
export interface WelcomeSeries {
  id: string;
  list: string;
  enabled: boolean;
  steps: { itemId: string; delayDays: number; reached: number }[];
  started: number;
  updatedAt: string;
}

export interface WelcomeRow {
  list: string;
  label: string;
  /** Null when the list has no series yet. */
  series: { enabled: boolean; steps: number; started: number } | null;
}

/** One row per list a signup form names or a series exists for, in that order. */
export async function welcomeOverview(principal: Principal, ui: string): Promise<WelcomeRow[]> {
  const { automations } = await runtime().invoker.run(useCases.listAutomations, principal, {});
  const rows = new Map<string, WelcomeRow>();
  for (const { id, label } of await signupLists(principal, ui))
    rows.set(id, { list: id, label, series: null });
  for (const a of automations)
    rows.set(a.list, {
      list: a.list,
      label: rows.get(a.list)?.label ?? a.list,
      series: { enabled: a.enabled, steps: a.steps.length, started: a.started },
    });
  return [...rows.values()];
}

export interface WelcomeItem {
  value: string;
  label: string;
}

/**
 * The items a step may name: published pages first, then articles, newest first within each, in
 * the site's default locale. Restricted items list too; core refuses them with a reason.
 */
async function itemOptions(principal: Principal, locale: string): Promise<WelcomeItem[]> {
  if (!can(principal, 'content:read')) return [];
  const options: WelcomeItem[] = [];
  for (const type of ['page', 'article'] as const) {
    const { items } = await runtime().invoker.run(useCases.listItems, principal, {
      type,
      locale,
      status: 'published',
      limit: 100,
    });
    for (const item of items)
      options.push({ value: item.id, label: `${pickAny(item.title, locale) ?? item.slug}` });
  }
  return options;
}

export interface WelcomeDetail {
  list: string;
  label: string;
  automation: WelcomeSeries | null;
  items: WelcomeItem[];
  canSend: boolean;
}

export async function welcomeDetail(
  principal: Principal,
  list: string,
  { ui, site }: { ui: string; site: string }
): Promise<WelcomeDetail> {
  const { automations } = await runtime().invoker.run(useCases.listAutomations, principal, {});
  const label = (await signupLists(principal, ui)).find((l) => l.id === list)?.label ?? list;
  return {
    list,
    label,
    automation: automations.find((a) => a.list === list) ?? null,
    items: await itemOptions(principal, site),
    canSend: can(principal, 'mailing:send'),
  };
}

/** The steps a posted form names, in row order; a row without an item is no step. */
export function postedSteps(data: FormData): { itemId: string; delayDays: number }[] {
  const steps = [];
  for (let i = 0; i < MAX_AUTOMATION_STEPS; i++) {
    const itemId = String(data.get(`step-${i}-item`) ?? '');
    if (!itemId) continue;
    const days = String(data.get(`step-${i}-days`) ?? '').trim();
    steps.push({ itemId, delayDays: days === '' ? 0 : Number(days) });
  }
  return steps;
}

/** The refusals of `mailing.automation.*` in the admin's words. */
export const WELCOME_ISSUES: Record<string, UiKey> = {
  'mailing.automation.same-day': 'admin.welcome.refused.sameDay',
  'mailing.automation.not-mailable': 'admin.welcome.refused.notMailable',
  'mailing.automation.no-item': 'admin.welcome.refused.notMailable',
  'mailing.automation.none': 'admin.welcome.refused.none',
};
