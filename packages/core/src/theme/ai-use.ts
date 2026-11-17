// Which machine uses of its published content a site reserves: one choice per site in
// three steps, from which robots.txt, its Content-Signal line (contentsignals.org) and the TDM
// reservation (W3C TDMRep, the machine-readable opt-out of EU DSM Directive article 4) all follow,
// so the three can never disagree. Search engines stay allowed in every step: a campaign or news
// site that hides from search hides from its readers. The default is `open`, because Mycel makes
// the site a source for agents (`llms.txt`, Markdown per page) and a site that wants less says so.
// Rejected: a free robots.txt per tenant (a typo can hide a whole site)
// and a toggle per crawler (the list changes faster than a site owner can follow; Mycel keeps it).
import { z } from 'zod';

export const AI_USES = ['open', 'no-training', 'search-only'] as const;
export const AiUse = z.enum(AI_USES);
export type AiUse = z.infer<typeof AiUse>;
export const DEFAULT_AI_USE: AiUse = 'open';

/** Crawlers that collect for model training only; blocking them costs no reader anything. */
export const TRAINING_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'meta-externalagent',
  'Bytespider',
] as const;
/** Agents that fetch a page to answer a question in an AI product (`ai-input`). */
export const ANSWER_AGENTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'MistralAI-User',
] as const;

export interface AiPolicy {
  /** The value of the `Content-Signal` line in robots.txt. */
  contentSignal: string;
  /** User agents that robots.txt disallows everywhere. */
  disallow: readonly string[];
  /** Whether text and data mining rights are reserved (TDMRep `tdm-reservation: 1`). */
  tdmReservation: boolean;
}

export function aiPolicy(use: AiUse | undefined): AiPolicy {
  switch (use ?? DEFAULT_AI_USE) {
    case 'open':
      return {
        contentSignal: 'search=yes, ai-input=yes, ai-train=yes',
        disallow: [],
        tdmReservation: false,
      };
    case 'no-training':
      return {
        contentSignal: 'search=yes, ai-input=yes, ai-train=no',
        disallow: TRAINING_CRAWLERS,
        tdmReservation: true,
      };
    case 'search-only':
      return {
        contentSignal: 'search=yes, ai-input=no, ai-train=no',
        disallow: [...TRAINING_CRAWLERS, ...ANSWER_AGENTS],
        tdmReservation: true,
      };
  }
}

/**
 * The robots.txt of a site: the `*` group with the content signal and the paths no crawler needs,
 * one group naming every disallowed agent, then the sitemap. A crawler that matches a named group
 * ignores the `*` group (RFC 9309 § 2.2.1), which is what a full disallow means anyway.
 */
export function robotsTxt(input: {
  use: AiUse | undefined;
  disallowPaths: readonly string[];
  sitemap: string;
}): string {
  const policy = aiPolicy(input.use);
  const lines = [
    'User-agent: *',
    `Content-Signal: ${policy.contentSignal}`,
    ...input.disallowPaths.map((path) => `Disallow: ${path}`),
    '',
  ];
  if (policy.disallow.length)
    lines.push(...policy.disallow.map((agent) => `User-agent: ${agent}`), 'Disallow: /', '');
  lines.push(`Sitemap: ${input.sitemap}`, '');
  return lines.join('\n');
}
