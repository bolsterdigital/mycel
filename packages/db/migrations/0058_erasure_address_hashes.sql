-- 0058: a registration holds every address hash of its supporter (ADR 032 rule 4 as amended
-- 2026-11-16; owner decision of 2026-11-06 that a signup after an erasure request stays). Apply
-- erases every address a registered id's own rows carry, also one she had before a change, but the
-- register held only the current address's hash. A new explicit signup on the older address
-- between the request and apply therefore found no registration, opened no lifecycle and was
-- erased with the old life. The register now takes one row per (supporter id, address hash):
-- `supporter.erase` writes the current address and every other address on the id's projection
-- and events, all with one time and actor, so admission opens a lifecycle on each of them.
--
-- The backup record follows the key: `erasure_backups` says which snapshot holds which row, and a
-- restore that loads a snapshot's register (five columns, unchanged) loads the older hashes with
-- it. Existing backup rows get the one hash their registration has; that is the key they already
-- meant, not a backfill.
--
-- Clean cut (owner decision 2026-11-15, no production installation yet): registrations made
-- before this migration keep their one hash. Their older addresses are still erased by apply
-- (packages/db/src/erasures.ts takes those locks), without the readmission protection.
--
-- Rejected: a second table for the older hashes (a fourth register in the backup, the restore
-- overlay, the export and the storage catalog, for rows with the same meaning and lifetime), a
-- hash array on the registration (changes the five-column snapshot format, ADR 032 rule 6), and
-- deriving "ended" at admission from the id's untombstoned rows (gone after apply, so a restored
-- signup would be judged differently from the one it restores).

alter table erasure_backups drop constraint erasure_backups_tenant_id_supporter_id_fkey;
alter table erasure_backups drop constraint erasure_backups_pkey;
alter table erasures drop constraint erasures_pkey;
alter table erasures add primary key (tenant_id, supporter_id, email_hash);

alter table erasure_backups add column email_hash text check (email_hash ~ '^[0-9a-f]{64}$');
-- The owner sees no tenant row under forced RLS (0018); lifted for this one statement, as 0053.
alter table erasures no force row level security;
alter table erasure_backups no force row level security;
update erasure_backups b set email_hash = e.email_hash
  from erasures e where e.tenant_id = b.tenant_id and e.supporter_id = b.supporter_id;
alter table erasures force row level security;
alter table erasure_backups force row level security;
alter table erasure_backups alter column email_hash set not null;
alter table erasure_backups add primary key (tenant_id, supporter_id, email_hash);
alter table erasure_backups add foreign key (tenant_id, supporter_id, email_hash)
  references erasures (tenant_id, supporter_id, email_hash);
