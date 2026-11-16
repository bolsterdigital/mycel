-- An organisation is an entry of the people register with its own kind (ADR 031, addendum
-- 2026-11-16), so groups, the grid and portability carry it unchanged. Every existing row is a
-- person. Rejected: a separate organisations table with its own groups and grid.
alter table people add column kind text not null default 'person'
  check (kind in ('person', 'organisation'));
