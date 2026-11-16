-- Patterns can be deleted from the admin (ADR 012 rule 8): documents made or filled from a pattern
-- hold their own copies, so the row goes outright and core releases its media usages in the same
-- transaction. The tenant isolation policy already covers delete for mycel_app. Rejected: a
-- soft-delete column with a trash, for a template any document still holding its blocks can save
-- again.
grant delete on patterns to mycel_app;
