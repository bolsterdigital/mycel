-- 0057: the site chrome keeps its footer text only (ADR 036 rule 10 as amended 2026-11-15,
-- #107 B2).
--
-- The menus of a site now live in the navigation document (0056), so the four chrome fields that
-- held them, `navigation`, `legal`, `support` and `help`, are removed from every
-- `site_settings.chrome`. `site.chrome.update` refuses them from here on and the public layout
-- reads its menus from the published navigation only.
--
-- The fields are dropped, not moved: Mycel has no production sites yet, so the owner decided on
-- 2026-11-15 that changes are clean cuts without backward compatibility. An installation that
-- still has chrome menus loses them and builds them again in the menu editor; an export from
-- before this migration is not a supported import input.
--
-- Rejected: turning the old fields into a published navigation document here and at import (the
-- first version of this migration), which kept a mapping, a database function with its grant and
-- an import fingerprint exception alive for data that does not exist.

-- backfill:begin
alter table site_settings no force row level security;
update site_settings set chrome = chrome - 'navigation' - 'legal' - 'support' - 'help'
 where chrome ?| array['navigation', 'legal', 'support', 'help'];
alter table site_settings force row level security;
-- backfill:end
