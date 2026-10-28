// The admin's shared components (brief #56 § A): every admin screen is built from these, on the
// tokens of theme/admin.css and the styles of ui.css. One import path keeps screens from reaching
// into single files, so a component can be split or renamed here without touching them.
export { default as Actions } from './Actions.svelte';
export { default as Badge } from './Badge.svelte';
export { default as Breadcrumb } from './Breadcrumb.svelte';
export { default as Button } from './Button.svelte';
export { default as Card } from './Card.svelte';
export { default as CardGrid } from './CardGrid.svelte';
export { default as Choices } from './Choices.svelte';
export { default as Dialog } from './Dialog.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as Field } from './Field.svelte';
export { default as Fieldset } from './Fieldset.svelte';
export { default as FileDrop } from './FileDrop.svelte';
export { default as MetaList } from './MetaList.svelte';
export { default as Notice } from './Notice.svelte';
export { default as PageHeader } from './PageHeader.svelte';
export { default as Pagination } from './Pagination.svelte';
export { default as Select } from './Select.svelte';
export { default as SubNav } from './SubNav.svelte';
export { default as Table } from './Table.svelte';
