-- Drafts have no delivery path. Published tracks from earlier installations stay readable.
alter table managed_videos add column draft_tracks jsonb not null default '{}',
  add column transcript_lexemes jsonb not null default '{}';
