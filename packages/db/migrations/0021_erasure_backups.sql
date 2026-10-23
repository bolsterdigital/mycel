-- 0021: which erasure registrations a backup holds (TODO #29B, brief recovery-b-erasure-durability;
-- ADR 011, ADR 019 rule 8). A registration in `erasures` (0019) only survives the loss of the
-- server once a restic snapshot holds it; until then a restore of the last backup brings the
-- person back and nothing remembers the erasure. `docker/backup/backup.sh` writes one row here
-- per registration its snapshot holds, with that snapshot's id, after `restic backup` succeeded:
-- both the full daily run and the `erasures` run every 15 minutes. A registration counts as a
-- completed erasure only when it has a row here (`ctx.erasures.status()`, docs/reference/export.md
-- § Erasure register).
--
-- The writer is `mycel_backup`, the login with BYPASSRLS the backup runs as (ADR 011, #18c), and
-- this insert is its one write privilege. That role is made by the image's superuser
-- (docker/postgres/init-backup-role.sh), not by a migration, so the grant goes in only where the
-- role exists; init-backup-role.sh grants it too, for a box that gets the backup login after this
-- migration ran. mycel_app reads its own tenant's rows (`status`), never writes them.
-- Rejected: a `secured_at` column on `erasures` (the register would no longer be append-only, and
-- the backup login would need update on it), a separate login for this one insert (a second
-- password in the backup container for the same job), and the worker recording it (the worker
-- has no restic and must not: it would need the repository key).

create table erasure_backups (
  tenant_id     uuid not null,
  supporter_id  uuid not null,
  -- The full restic snapshot id, so `restic restore <id>` finds exactly that snapshot.
  snapshot_id   text not null check (snapshot_id ~ '^[0-9a-f]{64}$'),
  secured_at    timestamptz not null default now(),
  primary key (tenant_id, supporter_id),
  foreign key (tenant_id, supporter_id) references erasures (tenant_id, supporter_id)
);

alter table erasure_backups enable row level security;
alter table erasure_backups force row level security;
create policy tenant_isolation on erasure_backups to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select on erasure_backups to mycel_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mycel_backup') then
    grant insert on erasure_backups to mycel_backup;
  end if;
end $$;
