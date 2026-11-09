-- Person grids use the existing immutable reference index, rather than a second usage table.
-- The change only extends its kind constraint; historical author references remain unchanged.
alter table content_block_refs drop constraint content_block_refs_type_check;
alter table content_block_refs add constraint content_block_refs_type_check
  check (type in ('form', 'item', 'author', 'section', 'media', 'person', 'person_group'));
