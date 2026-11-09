-- A submission pins its exact definition and field decisions (ADR 023). The snapshot is
-- submission-owned, so export and erasure follow the existing row. Rejected: looking up the
-- current form when confirming or reinterpreting old values after a field rename.
-- Historical rows remain null: do not invent evaluation evidence after the event.
alter table form_submissions add column evaluation jsonb;
