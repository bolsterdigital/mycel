// The log of a site (brief admin-operations-screens § 5, #82 PR 1b): every command the Invoker
// recorded, newest first, filtered on period, action and actor through `audit.list` and its
// cursor, the same use case HTTP and MCP expose. Filters are a GET form, so a filtered view is a
// URL that works without JavaScript and can be shared with a colleague. Dates are days in the
// admin's time zone: "up to and including" a day is before the start of the next. Members and
// API keys are read once so a row says a name instead of an id. Rejected: a free-text search
// (the log holds names and hashes, not text worth searching) and numbered pages (the log grows
// at the top, so page 2 shifts while it is read; a cursor does not). `audit.list` asks
// `tenant:admin` itself, and a cursor edited by hand is refused there as invalid input; `loaded`
// turns either refusal into the admin's 403 or 400 page.
import { AuditActorKind, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { adminTimeZone } from '#lib/server/admin/admin.js';
import { fromLocalInput } from '#lib/server/content-admin-publication.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OPERATION = /^[a-z][a-z0-9_.-]{0,99}$/;
const PAGE = 50;
/** What the action filter offers: every command, the only operations the Invoker records. */
const COMMANDS = Object.values(useCases)
  .filter((u) => u.kind === 'command')
  .map((u) => u.name);

/** The start of `day` in `zone`, or of the day after it; null when it is not a date. */
function dayStart(day: string, zone: string, after = false): Date | null {
  if (!DAY.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + (after ? 1 : 0)));
  if (!after && date.getUTCDate() !== d) return null;
  return fromLocalInput(`${date.toISOString().slice(0, 10)}T00:00`, zone);
}

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const principal = locals.principal!;
  const { zone } = await adminTimeZone(locals);

  const param = (name: string) => url.searchParams.get(name)?.trim() ?? '';
  const from = param('from');
  const to = param('to');
  const operation = param('operation');
  const actor = param('actor');
  const cursor = param('cursor');

  const fromAt = from ? dayStart(from, zone) : null;
  const toAt = to ? dayStart(to, zone, true) : null;
  const [kind, id] = actor.split(/:(.*)/s) as [string, string | undefined];
  const actorKind = AuditActorKind.safeParse(kind);

  const run = runtime().invoker;
  const [page, members, keys] = await Promise.all([
    loaded(
      run.run(useCases.listAudit, principal, {
        from: fromAt?.toISOString(),
        to: toAt?.toISOString(),
        operation: OPERATION.test(operation) ? operation : undefined,
        actorKind: actorKind.success ? actorKind.data : undefined,
        actorId: actorKind.success && id ? id.slice(0, 200) : undefined,
        cursor: cursor || undefined,
        limit: PAGE,
      })
    ),
    loaded(run.run(useCases.listMembers, principal, {})),
    loaded(run.run(useCases.listKeys, principal, {})),
  ]);

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries({ from, to, operation, actor })) if (v) query.set(k, v);
  const filtered = query.size > 0;
  const older = page.nextCursor
    ? `?${new URLSearchParams([...query, ['cursor', page.nextCursor]])}`
    : undefined;

  return {
    items: page.items,
    /** One moment for every relative time on the page, the same on server and client. */
    now: new Date().toISOString(),
    older,
    newest: cursor ? `?${query}` : undefined,
    filter: { from, to, operation, actor },
    filtered,
    invalidDate: Boolean((from && !fromAt) || (to && !toAt)),
    members: members.members.map((m) => ({ id: m.operatorId, name: m.name ?? m.email })),
    keys: keys.keys.map((k) => ({ id: k.id, name: k.name })),
    operations: COMMANDS,
  };
};
