-- Chapters per language beside the transcript (MY-305): a draft the editor saves and the copy
-- that publication made, each a normalised WebVTT chapters track keyed by locale.
alter table managed_videos add column draft_chapters jsonb not null default '{}',
  add column published_chapters jsonb not null default '{}';
