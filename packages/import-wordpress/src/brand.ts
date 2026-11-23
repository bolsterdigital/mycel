// Read Dreamkit's generated CSS values, where inheritance and overrides have already been applied.
// Rejected: reconstructing the Dreamkit token graph from a raw brand file or guessing from WXR.

import { ThemeColor, checkTheme, type Palette, type ResolvedTheme } from '@mycel/core';
import type { ReportLine } from './plan.js';

export type CampaignColours = Pick<
  Palette,
  'campaignForm' | 'campaignProgress' | 'campaignProgressFill'
>;

const PREFIX = '--wings-campaign-sidebar-';
const TOKENS = {
  campaignForm: ['form-bg-color', 'form-text-color'],
  campaignProgress: ['progress-bg-color', 'progress-text-color'],
  campaignProgressFill: ['progress-bar-bg-color'],
} as const;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function campaignBrand(source: unknown, report: ReportLine[]): CampaignColours {
  const vars = object(object(source)?.['css_vars']);
  if (!vars) {
    report.push({
      code: 'theme.campaign-skipped',
      detail:
        'Expected generated Wings tokens with a css_vars object. Resolve brand overrides in Dreamkit first.',
    });
    return {};
  }
  const read = (role: keyof CampaignColours) => {
    const names = TOKENS[role].map((suffix) => PREFIX + suffix);
    const colours = names.map((name) => {
      const value = vars[name];
      const hex = typeof value === 'string' ? value.trim() : '';
      const normalized = /^#[0-9a-f]{3}$/i.test(hex)
        ? '#' + [...hex.slice(1)].map((digit) => digit.repeat(2)).join('')
        : hex;
      return ThemeColor.safeParse(normalized).data?.toLowerCase();
    });
    const unresolved = names.filter((_, index) => !colours[index]);
    if (unresolved.length) {
      report.push({
        code: 'theme.campaign-skipped',
        detail: `light.${role}: missing or unresolved opaque hex colour (${unresolved.join(', ')})`,
      });
      return [];
    }
    return colours;
  };

  const [formBackground, formForeground] = read('campaignForm');
  const [progressBackground, progressForeground] = read('campaignProgress');
  const [fill] = read('campaignProgressFill');
  return {
    ...(formBackground &&
      formForeground && {
        campaignForm: { background: formBackground, foreground: formForeground },
      }),
    ...(progressBackground &&
      progressForeground && {
        campaignProgress: { background: progressBackground, foreground: progressForeground },
      }),
    ...(fill && { campaignProgressFill: fill }),
  };
}

export function applyCampaignBrand(
  theme: ResolvedTheme,
  colours: CampaignColours,
  report: ReportLine[]
): ResolvedTheme | undefined {
  const original = theme.palettes.light;
  const light = { ...original, ...colours };
  const updated = { ...theme, palettes: { ...theme.palettes, light } };
  const fails = (role: keyof CampaignColours) =>
    checkTheme(updated).issues.some((issue) => issue.path === `palettes.light.${role}`);
  const skipped = (role: keyof CampaignColours) => {
    report.push({
      code: 'theme.campaign-skipped',
      detail: `light.${role}: insufficient contrast in the destination palette`,
    });
  };

  if (colours.campaignForm && fails('campaignForm')) {
    skipped('campaignForm');
    light.campaignForm = original.campaignForm;
  }
  if (colours.campaignProgress && fails('campaignProgress')) {
    skipped('campaignProgress');
    light.campaignProgress = original.campaignProgress;
  }
  if (colours.campaignProgressFill && fails('campaignProgressFill')) {
    skipped('campaignProgressFill');
    light.campaignProgressFill = original.campaignProgressFill;
  }
  // A new progress surface can also invalidate a previously configured fill.
  if (colours.campaignProgress && fails('campaignProgressFill')) {
    skipped('campaignProgress');
    light.campaignProgress = original.campaignProgress;
  }
  return JSON.stringify(light) === JSON.stringify(original) ? undefined : updated;
}
