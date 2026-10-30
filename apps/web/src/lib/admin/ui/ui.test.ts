// Component tests of the admin's shared components (brief #56 § D): each is rendered with
// `svelte/server`, as the admin serves it (no client JavaScript), and checked for the semantics a
// screen relies on: native elements, label and description wiring, landmarks and current-page
// marks, and the localised copy the component brings itself. Layout at 320 CSS px and 200% text
// and axe run in the browser, over the catalogue (e2e/ui-gate.spec.ts).
import { describe, expect, it } from 'vitest';
import { createRawSnippet, type Component } from 'svelte';
import { render } from 'svelte/server';
import {
  Actions,
  Badge,
  BlockCard,
  Breadcrumb,
  Button,
  Card,
  CardGrid,
  Checkbox,
  Choices,
  ConfirmAction,
  CopyField,
  DashboardWidget,
  DetailPage,
  Dialog,
  EditPage,
  EmptyState,
  Field,
  Fieldset,
  FileDrop,
  FormPage,
  ICONS,
  Icon,
  IconSprite,
  ItemBar,
  KeyReveal,
  MetaList,
  NavGroup,
  Notice,
  OverviewPage,
  PageHeader,
  Pagination,
  Panel,
  Select,
  SettingsPage,
  SettingsSection,
  StatusCard,
  SubNav,
  SystemState,
  Table,
  Tabs,
  ViewSwitch,
} from './index.js';

const text = (html: string) => createRawSnippet(() => ({ render: () => `<span>${html}</span>` }));
const html = <P extends Record<string, unknown>>(component: Component<P>, props: P) => {
  // Without Svelte's hydration markers, which are not part of the contract.
  const out = render(component as Component<Record<string, unknown>>, { props }).body.replace(
    /<!--[^]*?-->/g,
    ''
  );
  // The CSP allows no style attribute and no inline script or style (#20c).
  expect(out).not.toMatch(/\sstyle=|<style|<script/);
  return out;
};

describe('Button', () => {
  it('is a submit button by default and a link with href', () => {
    expect(html(Button, { children: text('Save') })).toMatch(
      /^<button class="ui-button primary" type="submit"/
    );
    const link = html(Button, { variant: 'secondary', href: '/x', children: text('Download') });
    expect(link).toMatch(/^<a class="ui-button secondary" href="\/x"/);
    expect(link).not.toContain('type=');
  });
  it('keeps a given type and form attributes', () => {
    const out = html(Button, {
      variant: 'danger',
      type: 'button',
      name: 'action',
      value: 'delete',
      children: text('Delete'),
    });
    expect(out).toContain('class="ui-button danger"');
    expect(out).toContain('type="button"');
    expect(out).toContain('name="action"');
  });
});

describe('Actions', () => {
  it('marks a stacking group inside a size container', () => {
    const out = html(Actions, { stack: true, children: text('a') });
    expect(out).toMatch(/class="ui-actions-host"><div class="ui-actions stack"/);
  });
});

describe('Field', () => {
  it('wires label, hint and error to the input', () => {
    const out = html(Field, {
      id: 'title',
      name: 'title',
      label: 'Title',
      locale: 'nl',
      hint: 'Shown as heading',
      error: 'Fill in a title',
      required: true,
    });
    expect(out).toContain(
      '<label for="title" id="title-label">Title<span class="ui-required"> (verplicht)</span>'
    );
    expect(out).toContain('id="title-hint"');
    expect(out).toContain('id="title-error"');
    expect(out).toMatch(/<input[^>]*aria-describedby="title-hint title-error"/);
    expect(out).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(out).toMatch(/<input[^>]*required/);
    expect(out).toMatch(/<input[^>]*name="title"/);
  });
  it('keeps the hint behind an ⓘ that opens it as a popover, inline on request (#87)', () => {
    const out = html(Field, {
      id: 'title',
      label: 'Title',
      locale: 'nl',
      hint: 'Shown as heading',
    });
    expect(out).toMatch(
      /<button type="button" class="ui-hint-toggle" popovertarget="title-hint" aria-label="Uitleg" aria-describedby="title-label">/
    );
    expect(out).toMatch(/<p class="ui-hint" id="title-hint" popover="auto">\s*Shown as heading/);
    // The label comes before its ⓘ, and the hint stays the input's description.
    expect(out.indexOf('<label')).toBeLessThan(out.indexOf('ui-hint-toggle'));
    expect(out).toMatch(/<input[^>]*aria-describedby="title-hint"/);

    const inline = html(Field, {
      id: 'f',
      label: 'File',
      locale: 'en',
      hint: 'Drop files here',
      hintInline: true,
    });
    expect(inline).not.toContain('ui-hint-toggle');
    expect(inline).not.toContain('popover');
    expect(inline).toMatch(/<p class="ui-hint" id="f-hint">\s*Drop files here/);
  });
  it('leaves out an empty description and aria-invalid', () => {
    const out = html(Field, { id: 'x', label: 'X', locale: 'en' });
    expect(out).not.toContain('aria-describedby');
    expect(out).not.toContain('aria-invalid');
    expect(out).not.toContain('ui-required');
  });
  it('marks a control invalid whose message stands in the summary', () => {
    const out = html(Field, {
      id: 'b-1-p-text-nl',
      label: 'Text (nl)',
      locale: 'en',
      invalid: true,
    });
    expect(out).toMatch(/^<div class="ui-field invalid">/);
    expect(out).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(out).not.toContain('aria-describedby');
  });
});

describe('Checkbox', () => {
  it('is one native checkbox with its label and an optional hint', () => {
    const out = html(Checkbox, {
      id: 'noindex',
      name: 'noindex',
      label: 'Hide from search engines',
      checked: true,
      hint: 'Also from the site search.',
    });
    expect(out).toMatch(/<input type="checkbox" id="noindex" name="noindex" checked/);
    expect(out).toContain('<label for="noindex">Hide from search engines</label>');
    expect(out).toMatch(/aria-describedby="noindex-hint"/);
    expect(out).toContain('id="noindex-hint"');
    expect(html(Checkbox, { id: 'x', name: 'x', label: 'X' })).not.toMatch(
      /checked|disabled|aria-describedby/
    );
    expect(html(Checkbox, { id: 'x', name: 'x', label: 'X', disabled: true })).toMatch(
      /<input type="checkbox" id="x" name="x" disabled/
    );
  });
});

describe('Panel', () => {
  it('is a native details named by its summary, open on request, with a hook class', () => {
    const out = html(Panel, {
      id: 'block-1',
      summary: '1. Text: Welcome',
      open: true,
      class: 'block',
      children: text('FORM'),
    });
    expect(out).toMatch(/^<details class="ui-panel block" id="block-1" open/);
    expect(out).toContain('<summary>1. Text: Welcome</summary>');
    expect(out).toContain('<div class="ui-panel-body"><span>FORM</span></div>');
    expect(html(Panel, { summary: 'S', children: text('x') })).not.toMatch(/ open/);
  });
});

describe('BlockCard', () => {
  it('names the block in its head, keeps actions out of the summary and folds the fields', () => {
    const out = html(BlockCard, {
      id: 'block-1',
      title: '2. Image',
      class: 'block',
      text: 'Over two thousand came',
      thumb: '/admin/probe/media/m1/thumb',
      empty: 'Still empty',
      actions: text('ACTIONS'),
      children: text('FIELDS'),
    });
    expect(out).toMatch(/^<section class="ui-block-card" aria-labelledby="block-1-title">/);
    expect(out).toContain('<h4 class="ui-block-card-title" id="block-1-title">2. Image</h4>');
    expect(out).toMatch(/<details class="ui-block-card-fold block" id="block-1">/);
    const summary = out.slice(out.indexOf('<summary>'), out.indexOf('</summary>'));
    expect(summary).toContain('<img src="/admin/probe/media/m1/thumb" alt=""');
    expect(summary).toContain('Over two thousand came');
    expect(summary).not.toContain('ACTIONS');
    expect(out.indexOf('ACTIONS')).toBeLessThan(out.indexOf('<details'));
    expect(out).toContain('<div class="ui-block-card-body"><span>FIELDS</span></div>');
    expect(out).not.toContain('Still empty');
  });
  it('lists the entries of a list one per line, and says when the block is empty', () => {
    const faq = html(BlockCard, {
      id: 'block-2',
      title: '3. FAQ',
      text: '',
      entries: ['When?', 'Where?'],
      empty: 'Still empty',
      open: true,
      children: text('x'),
    });
    expect(faq.match(/class="ui-block-card-entry"/g)).toHaveLength(2);
    expect(faq).toMatch(/<details[^>]* open/);
    const empty = html(BlockCard, {
      id: 'b',
      title: '1. Text',
      text: '',
      empty: 'Still empty',
      children: text('x'),
    });
    expect(empty).toContain('<span class="ui-block-card-empty">Still empty</span>');
  });
});

describe('Select', () => {
  it('selects the given value inside a labelled field', () => {
    const out = html(Select, {
      id: 'kind',
      name: 'kind',
      label: 'Type',
      locale: 'en',
      value: 'article',
      options: [
        { value: 'page', label: 'Page' },
        { value: 'article', label: 'Article' },
      ],
    });
    expect(out).toContain('<label for="kind" id="kind-label">Type</label>');
    expect(out).toMatch(/<select name="kind" id="kind"/);
    expect(out).toMatch(/<option value="article" selected/);
    expect(out).not.toMatch(/<option value="page" selected/);
  });
});

describe('Choices', () => {
  it('is a fieldset of native inputs, each with its own label', () => {
    const out = html(Choices, {
      id: 'access',
      name: 'access',
      legend: 'Who can see this',
      locale: 'en',
      hint: 'Restricted needs a login',
      selected: ['public'],
      options: [
        { value: 'public', label: 'Public' },
        { value: 'restricted', label: 'Restricted' },
      ],
    });
    expect(out).toMatch(/<fieldset[^>]*aria-describedby="access-hint"/);
    // Named by the legend's text alone, so the ⓘ's own name is not part of the question.
    expect(out).toMatch(/<fieldset[^>]*aria-labelledby="access-legend"/);
    expect(out).toContain('<legend><span id="access-legend">Who can see this</span><button');
    expect(out).toContain(
      'popovertarget="access-hint" aria-label="Help" aria-describedby="access-legend"'
    );
    expect(out).toMatch(/<p class="ui-hint" id="access-hint" popover="">/);
    expect(out).toMatch(/type="radio" id="access-public" name="access" value="public" checked/);
    expect(out).toContain('<label for="access-restricted">Restricted</label>');
  });
  it('marks a required radio group on every input', () => {
    const out = html(Choices, {
      id: 'c',
      name: 'c',
      legend: 'C',
      locale: 'en',
      required: true,
      options: [{ value: 'a', label: 'A' }],
    });
    expect(out).toContain('(required)');
    expect(out).toMatch(/<input[^>]*required/);
  });
  it('renders a label through its own snippet, keeping the plain label as data', () => {
    const out = html(Choices, {
      id: 'cap',
      name: 'capabilities',
      legend: 'Capabilities',
      locale: 'en',
      type: 'checkbox',
      options: [{ value: 'content:write', label: 'content:write' }],
      optionLabel: createRawSnippet((option: () => { value: string; label: string }) => ({
        render: () => `<span>${option().label.replace(':', ':<wbr>')}</span>`,
      })),
    });
    expect(out).toMatch(/type="checkbox" id="cap-content:write" name="capabilities"/);
    expect(out).toContain('<label for="cap-content:write"><span>content:<wbr>write</span></label>');
  });
});

describe('FileDrop', () => {
  it('is the native file input with the localised drop hint', () => {
    const out = html(FileDrop, {
      id: 'file',
      name: 'file',
      label: 'Bestand',
      locale: 'nl',
      accept: 'image/*',
    });
    expect(out).toMatch(/<input class="ui-filedrop" type="file" name="file" accept="image\/\*"/);
    expect(out).toContain('Kies een bestand, of sleep het op het veld');
    expect(out).toMatch(/aria-describedby="file-hint"/);
  });
});

describe('Fieldset', () => {
  it('folds into a closed <details> when collapsed', () => {
    expect(html(Fieldset, { legend: 'Display', collapsed: true, children: text('x') })).toMatch(
      /^<details class="ui-fold"><summary>Display<\/summary>\s*<fieldset/
    );
    expect(html(Fieldset, { legend: 'Display', children: text('x') })).toMatch(
      /^<fieldset class="ui-fieldset"><legend>Display<\/legend>/
    );
  });
});

describe('Notice and Badge', () => {
  it('interrupts only for an error', () => {
    expect(html(Notice, { tone: 'error', children: text('x') })).toContain('role="alert"');
    expect(html(Notice, { tone: 'success', children: text('x') })).toContain('role="status"');
  });
  it('is no live region as a standing note of a panel', () => {
    expect(html(Notice, { tone: 'warning', live: false, children: text('x') })).not.toContain(
      'role='
    );
  });
  it('carries its tone as a class around the word', () => {
    expect(html(Badge, { tone: 'warning', children: text('Restricted') })).toBe(
      '<span class="ui-badge warning"><span>Restricted</span></span>'
    );
  });
});

describe('EmptyState', () => {
  it('uses the given heading level', () => {
    expect(html(EmptyState, { title: 'No articles yet', level: 3 })).toContain(
      '<h3 class="ui-empty-title">No articles yet</h3>'
    );
  });
});

describe('Table', () => {
  const props = {
    id: 'files',
    caption: 'Files',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'size', label: 'Size', numeric: true },
    ],
    sort: { key: 'name', dir: 'asc' as const },
    sortHref: (key: string, dir: string) => `?sort=${key}&dir=${dir}`,
    rows: text('rows'),
  };
  it('sorts through links and marks the sorted column', () => {
    const out = html(Table, props);
    expect(out).toMatch(/role="region" aria-labelledby="files-caption" tabindex="0"/);
    expect(out).toContain('<caption id="files-caption">Files</caption>');
    expect(out).toMatch(
      /<th scope="col" aria-sort="ascending"[^>]*><a href="\?sort=name&amp;dir=desc"/
    );
    // A column that does not sort has no link and no aria-sort.
    expect(out).toMatch(/<th scope="col" class="numeric">Size<\/th>/);
  });
  it('hides a caption that repeats the heading above, and keeps it as the name (#87)', () => {
    const out = html(Table, { ...props, hideCaption: true });
    expect(out).toContain('<caption id="files-caption" class="ui-visually-hidden">Files</caption>');
    expect(out).toMatch(/role="region" aria-labelledby="files-caption"/);
  });
});

describe('Card and CardGrid', () => {
  it('makes the heading the one link of a linked card', () => {
    const out = html(Card, { title: 'poster.jpg', href: '/m/1', children: text('2 MB') });
    expect(out).toMatch(/^<article class="ui-card linked">/);
    expect(out).toContain('<h3 class="ui-card-title"><a href="/m/1">poster.jpg</a></h3>');
    expect(out.match(/<a /g)).toHaveLength(1);
  });
  it('gives its heading an id for a region that points at it', () => {
    expect(html(Card, { title: 'Language nl', id: 'publication-nl' })).toContain(
      '<h3 class="ui-card-title" id="publication-nl">Language nl</h3>'
    );
  });
  it('renders one list item per card', () => {
    const card = createRawSnippet((item: () => string) => ({
      render: () => `<p>${item()}</p>`,
    }));
    const out = html(CardGrid<string>, { items: ['a', 'b'], key: (s: string) => s, card });
    expect(out).toBe('<ul class="ui-card-grid"><li><p>a</p></li><li><p>b</p></li></ul>');
  });
});

describe('MetaList', () => {
  it('is a definition list with optional links', () => {
    const out = html(MetaList, {
      items: [
        { term: 'Size', value: '2 MB' },
        { term: 'Used', value: 'in 1 place', href: '/content' },
      ],
    });
    expect(out).toMatch(/<dt>Size<\/dt>\s*<dd>2 MB<\/dd>/);
    expect(out).toContain('<dd><a href="/content">in 1 place</a></dd>');
  });
  it('lists several targets of one fact as links', () => {
    const out = html(MetaList, {
      items: [
        {
          term: 'Used in',
          value: '',
          links: [
            { label: 'Home', href: '/c/1' },
            { label: 'About', href: '/c/2' },
          ],
        },
      ],
    });
    expect(out).toMatch(
      /<ul class="ui-meta-links"><li><a href="\/c\/1">Home<\/a><\/li><li><a href="\/c\/2">About<\/a><\/li><\/ul>/
    );
  });
});

describe('page patterns', () => {
  const crumbs = [{ label: 'Probe', href: '/admin/probe' }, { label: 'Media' }];

  it('ViewSwitch marks the current view in a labelled nav of links', () => {
    const out = html(ViewSwitch, {
      label: 'View',
      items: [
        { href: '?', label: 'Grid', current: true },
        { href: '?view=list', label: 'List' },
      ],
    });
    expect(out).toMatch(/^<nav class="ui-view-switch" aria-label="View">/);
    expect(out).toContain('<a href="?" aria-current="page">Grid</a>');
    expect(out).toContain('<a href="?view=list">List</a>');
  });

  it('OverviewPage: one main and h1, the list under an h2, the empty state instead of the list', () => {
    const full = html(OverviewPage, {
      title: 'Media',
      locale: 'en',
      breadcrumb: crumbs,
      listTitle: 'Library',
      views: { label: 'View', items: [{ href: '?', label: 'Grid', current: true }] },
      paging: { next: '?cursor=x' },
      actions: text('Upload'),
      children: text('the grid'),
    });
    expect(full.match(/<main/g)).toHaveLength(1);
    expect(full.match(/<h1/g)).toHaveLength(1);
    expect(full).toMatch(/<section class="ui-overview-list" aria-labelledby="ui-overview-title">/);
    expect(full).toContain('<h2 id="ui-overview-title">Library</h2>');
    expect(full).toContain('the grid');
    expect(full).toContain('rel="next"');
    // The header's action comes before the list in the reading order.
    expect(full.indexOf('Upload')).toBeLessThan(full.indexOf('the grid'));

    const empty = html(OverviewPage, {
      title: 'Media',
      locale: 'en',
      listTitle: 'Library',
      empty: { title: 'No media yet.', body: 'Upload a file.' },
      children: text('the grid'),
    });
    expect(empty).toContain('No media yet.');
    expect(empty).not.toContain('the grid');

    // One visible heading (#87): a list title equal to the page title is for screen readers only.
    const same = html(OverviewPage, {
      title: 'Pages',
      locale: 'en',
      listTitle: 'Pages',
      children: text('the table'),
    });
    expect(same).toMatch(/<h2 id="ui-overview-title" class="ui-visually-hidden">\s*Pages/);
    expect(full).not.toContain('ui-visually-hidden');
  });

  it('DetailPage: a named preview region before the facts, the actions at the end', () => {
    const out = html(DetailPage, {
      title: 'poster.jpg',
      locale: 'en',
      previewLabel: 'Preview',
      preview: text('IMG'),
      meta: text('FACTS'),
      children: text('FORM'),
      footer: text('DELETE'),
    });
    expect(out).toContain('<section class="ui-detail-preview" aria-label="Preview">');
    const order = ['IMG', 'FACTS', 'FORM', 'DELETE'].map((s) => out.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toMatch(/<div class="ui-detail-footer">/);
  });

  it('EditPage: one main and h1, the fields before a named side column', () => {
    const out = html(EditPage, {
      title: 'About us',
      locale: 'en',
      asideLabel: 'Status and publication',
      children: text('FIELDS'),
      aside: text('PUBLISH'),
      notices: text('SAVED'),
    });
    expect(out).toMatch(/^<main class="page admin ui-edit-page">/);
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('<aside class="ui-edit-side" aria-label="Status and publication">');
    const order = ['SAVED', 'FIELDS', 'PUBLISH'].map((s) => out.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('EditPage: a live preview is a grid child of its own, between the columns (#66 PR 3)', () => {
    const out = html(EditPage, {
      title: 'About us',
      locale: 'en',
      asideLabel: 'Status and publication',
      form: { id: 'item-edit' },
      children: text('FIELDS'),
      preview: text('PREVIEW'),
      aside: text('PUBLISH'),
    });
    expect(out).toContain(
      '<div class="ui-edit-main"><span>FIELDS</span></div> <span>PREVIEW</span> <aside'
    );
  });

  it('SettingsPage and SettingsSection: sub-navigation, a form and a confirmation per section', () => {
    const page = html(SettingsPage, {
      title: 'Settings',
      locale: 'en',
      nav: { label: 'Sections', items: [{ href: '?', label: 'General', current: true }] },
      children: text('SECTIONS'),
    });
    expect(page).toContain('<nav class="ui-subnav" aria-label="Sections">');
    expect(page.indexOf('ui-subnav')).toBeLessThan(page.indexOf('SECTIONS'));

    const section = html(SettingsSection, {
      id: 'general',
      title: 'Name and languages',
      action: '?/general',
      submit: 'Save',
      saved: 'Saved.',
      children: text('FIELDS'),
    });
    expect(section).toMatch(
      /^<section class="ui-settings-section" aria-labelledby="general-title">/
    );
    expect(section).toContain('<h2 id="general-title">Name and languages</h2>');
    expect(section).toMatch(/role="status">\s*<p>Saved\.<\/p>/);
    expect(section).toMatch(/<form method="post" action="\?\/general">/);
    expect(section).toMatch(/<button class="ui-button primary" type="submit">Save<\/button>/);
    expect(
      html(SettingsSection, {
        id: 'g',
        title: 'T',
        action: '?/g',
        submit: 'Save',
        children: text('F'),
      })
    ).not.toContain('role="status"');
    const upload = html(SettingsSection, {
      id: 'logo',
      title: 'Logo',
      action: '?/brand',
      enctype: 'multipart/form-data',
      submit: 'unused',
      actions: text('OWN ACTIONS'),
      children: text('F'),
    });
    expect(upload).toMatch(
      /<form method="post" action="\?\/brand" enctype="multipart\/form-data">/
    );
    expect(upload).toContain('OWN ACTIONS');
    expect(upload).not.toContain('unused');
  });

  // #81 PR 3: a section of facts only, and the unsaved note as an enhancement.
  it('SettingsSection: no form without an action, an unsaved note only on request', () => {
    const facts = html(SettingsSection, { id: 'f', title: 'General', children: text('FACTS') });
    expect(facts).toContain('<span>FACTS</span>');
    expect(facts).not.toMatch(/<form|<button/);
    const guarded = render(SettingsSection as Component<Record<string, unknown>>, {
      props: {
        id: 'g',
        title: 'T',
        action: '?/g',
        submit: 'Save',
        unsaved: 'Unsaved changes',
        children: text('F'),
      },
    });
    expect(guarded.body).toMatch(/<form method="post" action="\?\/g" data-unsaved="">/);
    expect(guarded.body).toContain(
      '<p class="ui-hint" hidden="" data-unsaved-note="">Unsaved changes</p>'
    );
    expect(guarded.head).toContain('<script type="module" src="/_admin/unsaved.js"></script>');
    const plain = render(SettingsSection as Component<Record<string, unknown>>, {
      props: { id: 'g', title: 'T', action: '?/g', submit: 'Save', children: text('F') },
    });
    expect(plain.body).not.toMatch(/data-unsaved/);
    expect(plain.head).not.toContain('unsaved.js');
  });

  it('FormPage: save first, cancel as a link, both after the fields', () => {
    const out = html(FormPage, {
      title: 'New page',
      locale: 'en',
      action: '?/create',
      submit: 'Create',
      cancel: { href: '/admin/probe/content', label: 'Cancel' },
      children: text('FIELDS'),
    });
    expect(out).toMatch(/<form method="post" action="\?\/create">/);
    const [fields, save, cancel] = ['FIELDS', '>Create<', '>Cancel<'].map((s) => out.indexOf(s));
    expect(fields).toBeLessThan(save!);
    expect(save).toBeLessThan(cancel!);
    expect(out).toContain('<a class="ui-button link" href="/admin/probe/content">Cancel</a>');
  });

  it('SystemState: a page of its own with the h1, or a region with an h2; loading is a status', () => {
    const page = html(SystemState, {
      kind: 'forbidden',
      title: 'No access',
      page: true,
      children: text('ask an admin'),
    });
    expect(page).toMatch(
      /^<main class="page admin ui-state-page"><div class="ui-state forbidden">/
    );
    expect(page).toContain('<h1 class="ui-state-title">No access</h1>');
    expect(page).not.toContain('role=');

    const loading = html(SystemState, { kind: 'loading', title: 'Loading' });
    expect(loading).toMatch(/^<div class="ui-state loading" role="status">/);
    expect(loading).toContain('<h2 class="ui-state-title">Loading</h2>');
  });
});

describe('navigation', () => {
  it('marks the current section of a sub-navigation', () => {
    const out = html(SubNav, {
      label: 'Settings',
      items: [
        { href: '/a', label: 'General', current: true },
        { href: '/b', label: 'Theme' },
      ],
    });
    expect(out).toMatch(/^<nav class="ui-subnav" aria-label="Settings">/);
    expect(out).toContain('<a href="/a" aria-current="page">General</a>');
    expect(out).toContain('<a href="/b">Theme</a>');
  });
  it('ends a breadcrumb at the current page, not a link', () => {
    const out = html(Breadcrumb, {
      locale: 'nl',
      items: [
        { label: 'Sites', href: '/admin' },
        { label: 'Media', href: '/ignored' },
      ],
    });
    expect(out).toContain('aria-label="Kruimelpad"');
    expect(out).toContain('<a href="/admin">Sites</a>');
    expect(out).toContain('<span aria-current="page">Media</span>');
    expect(out).not.toContain('/ignored');
  });
  it('paginates with links in the operator language and hides when there is nowhere to go', () => {
    const out = html(Pagination, {
      locale: 'nl',
      previous: '?p=1',
      next: '?p=3',
      position: '2 van 5',
    });
    expect(out).toContain('aria-label="Paginering"');
    expect(out).toMatch(/href="\?p=1" rel="prev"><span aria-hidden="true">←<\/span> Vorige/);
    expect(out).toMatch(/rel="next">Volgende/);
    expect(html(Pagination, { locale: 'en' })).toBe('');
  });
  it('gives a page one h1 with its primary action beside it', () => {
    const out = html(PageHeader, {
      title: 'Media',
      locale: 'en',
      breadcrumb: [{ label: 'Sites', href: '/admin' }, { label: 'Media' }],
      actions: text('Upload'),
    });
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('aria-label="Breadcrumb"');
    expect(out).toContain('<div class="ui-page-actions"><span>Upload</span></div>');
  });
});

describe('Dialog', () => {
  it('opens and closes through native invokers, named by its heading', () => {
    const out = html(Dialog, {
      id: 'lightbox',
      title: 'poster.jpg',
      trigger: 'View full size',
      locale: 'nl',
      wide: true,
      children: text('img'),
    });
    expect(out).toMatch(
      /<button class="ui-button secondary" type="button" commandfor="lightbox" command="show-modal">View full size<\/button>/
    );
    expect(out).toMatch(
      /<dialog class="ui-dialog wide" id="lightbox" aria-labelledby="lightbox-title" closedby="any">/
    );
    expect(out).toMatch(/commandfor="lightbox" command="close">Sluiten<\/button>/);
  });
});

// #81 PR 1: the members and access screen.
describe('ConfirmAction', () => {
  it('asks in place and posts only from its second, named button', () => {
    const out = html(ConfirmAction, {
      label: 'Revoke key',
      question: 'This cannot be undone.',
      confirm: 'Yes, revoke',
      name: 'newsletter_sync',
      formaction: '?/revoke',
    });
    expect(out).toMatch(
      /^<details class="ui-fold ui-confirm"><summary class="ui-button secondary">/
    );
    // The summary opens; only the button inside submits, named after what it acts on.
    expect(out).toContain('<summary class="ui-button secondary">Revoke key</summary>');
    expect(out).toContain(
      '<button class="ui-button danger" type="submit" formaction="?/revoke" aria-label="Yes, revoke: newsletter_sync">Yes, revoke</button>'
    );
    expect(out.match(/<button/g)).toHaveLength(1);
    expect(out).toContain('<p>This cannot be undone.</p>');
  });
  it('carries a name and value for the row it acts on, and a light summary on request', () => {
    const out = html(ConfirmAction, {
      label: 'Remove',
      question: 'Sure?',
      confirm: 'Yes',
      variant: 'link',
      field: { name: 'remove', value: 'b1' },
    });
    expect(out).toContain('<summary class="ui-button link">Remove</summary>');
    expect(out).toContain('name="remove" value="b1"');
  });
  it("posts to the form's own action without formaction", () => {
    const out = html(ConfirmAction, { label: 'Remove', question: 'Sure?', confirm: 'Yes' });
    expect(out).toContain('<button class="ui-button danger" type="submit">Yes</button>');
    expect(out).not.toContain('aria-label');
  });
});

describe('KeyReveal', () => {
  it('shows the value once, selectable, with a copy button that starts hidden', () => {
    const rendered = render(KeyReveal as Component<Record<string, unknown>>, {
      props: { id: 'new-key', title: 'Your new API key: sync', value: 'mycel_abc', locale: 'nl' },
    });
    const out = html(KeyReveal, {
      id: 'new-key',
      title: 'Your new API key: sync',
      value: 'mycel_abc',
      locale: 'nl',
    });
    expect(out).toMatch(
      /<section class="ui-reveal" aria-labelledby="new-key-title"><h2 id="new-key-title">/
    );
    expect(out).toContain('Dit is de enige keer dat je dit ziet');
    expect(out).toContain('<output class="ui-copy-value" id="new-key-value">mycel_abc</output>');
    // Without the script the button never shows: no dead control.
    expect(out).toMatch(
      /<button class="ui-button secondary" type="button" hidden="" data-copy="new-key-value"/
    );
    expect(out).toContain('data-copied="Gekopieerd"');
    // The enhancement is a same-origin module in the head, the only script it brings.
    expect(rendered.head).toContain('<script type="module" src="/_admin/copy.js"></script>');
  });
});

// #81 PR 2: the domains screen.
describe('CopyField', () => {
  it('shows a labelled value with a copy button named after the label, hidden without script', () => {
    const props = { id: 'dns-0-txt-value', label: 'TXT record: Value', value: 'abc', locale: 'en' };
    const rendered = render(CopyField as Component<Record<string, unknown>>, { props });
    const out = html(CopyField, props);
    expect(out).toContain(
      '<span class="ui-copy-label" id="dns-0-txt-value-label">TXT record: Value</span>'
    );
    // A <code>, not an <output>: no live region per value.
    expect(out).toContain('<code class="ui-copy-value" id="dns-0-txt-value">abc</code>');
    expect(out).not.toContain('<output');
    expect(out).toMatch(
      /<button class="ui-button secondary" type="button" hidden="" id="dns-0-txt-value-copy" aria-labelledby="dns-0-txt-value-copy dns-0-txt-value-label" data-copy="dns-0-txt-value"/
    );
    expect(out).toContain('>Copy</button>');
    expect(rendered.head).toContain('<script type="module" src="/_admin/copy.js"></script>');
  });
});

// #66 PR 1: the shell's navigation, its icons, the tabs of the edit screen and the dashboard.
describe('Icon and IconSprite', () => {
  it('draws a hidden local reference to one symbol of the sprite', () => {
    const out = html(Icon, { name: 'globe' });
    expect(out).toMatch(/^<svg class="ui-icon" aria-hidden="true" focusable="false"/);
    expect(out).toContain('<use href="#icon-globe">');
  });
  it('holds every icon once, hidden, with no external reference', () => {
    const out = html(IconSprite, {});
    expect(out).toMatch(/^<svg class="ui-icon-sprite" aria-hidden="true"/);
    for (const name of Object.keys(ICONS)) {
      expect(out.split(`id="icon-${name}"`)).toHaveLength(2);
    }
    expect(out).not.toMatch(/href=|xlink/);
  });
});

describe('NavGroup', () => {
  const items = [
    { href: '/a', label: 'Pages', icon: 'file-text' as const, current: true },
    { href: '/b', label: 'Articles', icon: 'newspaper' as const },
  ];
  it('names its list by its label, not a heading, and marks the current link', () => {
    const out = html(NavGroup, { id: 'g', label: 'Content', items });
    expect(out).toContain('<p class="ui-navgroup-label" id="g-label">Content</p>');
    expect(out).toContain('<ul aria-labelledby="g-label">');
    expect(out).not.toMatch(/<h\d/);
    expect(out).toMatch(
      /<a href="\/a" aria-current="page"><svg class="ui-icon"[^]*?<span>Pages<\/span><\/a>/
    );
    expect(out).not.toMatch(/href="\/b" aria-current/);
  });
  it("lists a screen's sections under its item, the section as the current page (#87)", () => {
    const out = html(NavGroup, {
      id: 'g',
      label: 'Manage',
      items: [
        {
          href: '/site',
          label: 'Settings',
          icon: 'settings' as const,
          current: true,
          children: [
            { href: '/site?s=general', label: 'General', current: true },
            { href: '/site?s=brand', label: 'Brand' },
          ],
        },
        { href: '/leden', label: 'Members', icon: 'users' as const },
      ],
    });
    expect(out).toMatch(/<a href="\/site" aria-current="true">/);
    expect(out).toContain(
      '<ul class="ui-navgroup-sub"><li><a href="/site?s=general" aria-current="page">General</a></li><li><a href="/site?s=brand">Brand</a></li></ul>'
    );
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    // An item without sections has no sub-list.
    expect(out.match(/ui-navgroup-sub/g)).toHaveLength(1);
  });
  it('has no label when none is given, and renders nothing without items', () => {
    expect(html(NavGroup, { id: 'g', items })).not.toContain('aria-labelledby');
    expect(html(NavGroup, { id: 'g', label: 'Library', items: [] })).toBe('');
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'content', label: 'Content', content: text('Title and blocks') },
    { id: 'seo', label: 'Findability', content: text('Slug') },
  ];
  it('renders every section with its heading, and a hidden tablist for the script', () => {
    const out = html(Tabs, { id: 't', label: 'Item', tabs });
    expect(out).toMatch(/<div class="ui-tabs-list" role="tablist" aria-label="Item" hidden/);
    expect(out).toMatch(
      /<section class="ui-tabs-panel" id="t-seo" aria-labelledby="t-seo-title"><h2 class="ui-tabs-title" id="t-seo-title">Findability<\/h2>\s*<span>Slug<\/span><\/section>/
    );
    expect(out).toContain('<span>Title and blocks</span>');
  });
  it('selects the first tab and leaves the others out of the tab order', () => {
    const out = html(Tabs, { id: 't', label: 'Item', tabs, level: 3 });
    expect(out).toContain(
      'id="t-tab-content" aria-controls="t-content" aria-selected="true" tabindex="0"'
    );
    expect(out).toContain(
      'id="t-tab-seo" aria-controls="t-seo" aria-selected="false" tabindex="-1"'
    );
    expect(out).toContain('<h3 class="ui-tabs-title"');
  });
});

describe('DashboardWidget', () => {
  it('is a region named by its heading, with its content', () => {
    const out = html(DashboardWidget, {
      id: 'w',
      title: 'Usage and limits',
      locale: 'en',
      children: text('3 of 5'),
    });
    expect(out).toMatch(
      /^<section class="ui-widget" aria-labelledby="w"><h2 class="ui-widget-title" id="w">Usage and limits<\/h2>\s*<span>3 of 5<\/span>/
    );
  });
  it('says in the admin locale that an empty widget comes later', () => {
    const out = html(DashboardWidget, { id: 'w', title: 'Bezoek', locale: 'nl', level: 3 });
    expect(out).toContain('class="ui-widget empty"');
    expect(out).toContain('<h3 class="ui-widget-title" id="w">Bezoek</h3>');
    expect(out).toContain('<p class="ui-widget-later">Komt later.</p>');
  });
});

describe('ItemBar', () => {
  it('has the back link, the one <h1>, the state linked to its card, and the actions', () => {
    const out = html(ItemBar, {
      back: { href: '/admin/probe/content?type=page', label: 'Pages' },
      title: 'Edit page',
      state: 'Draft',
      stateHref: '#publication-nl',
      actions: text('<button>Save</button>'),
    });
    expect(out).toMatch(/^<header class="ui-item-bar">/);
    expect(out).toContain('<a class="ui-item-bar-back" href="/admin/probe/content?type=page">');
    expect(out).toContain('</svg>Pages</a>');
    expect(out).toContain('<h1 class="ui-item-bar-title">Edit page</h1>');
    expect(out).toContain(
      '<a class="ui-item-bar-state" href="#publication-nl"><span class="ui-badge neutral">Draft</span></a>'
    );
    expect(out).toContain('<div class="ui-actions end"><span><button>Save</button></span></div>');
  });
  it('shows the state without a link, and no action group without actions', () => {
    const out = html(ItemBar, {
      back: { href: '/x', label: 'Articles' },
      title: 'Edit article',
      state: 'Published, changed since',
      tone: 'warning',
    });
    expect(out).toContain('<span class="ui-badge warning">Published, changed since</span>');
    expect(out).not.toContain('ui-item-bar-state');
    expect(out).not.toContain('ui-actions');
  });
});

describe('StatusCard', () => {
  it('is a region named by its heading: the state, then notes, then the actions, then more', () => {
    const out = html(StatusCard, {
      id: 'publication-nl',
      title: 'Status and publication',
      state: 'Draft',
      children: text('<p>Restricted</p>'),
      actions: text('<button>Publish</button>'),
      more: text('<details><summary>Schedule</summary></details>'),
    });
    expect(out).toMatch(
      /^<section class="ui-status-card" id="publication-nl" aria-labelledby="publication-nl-title"><h2 id="publication-nl-title" class="ui-status-card-title">Status and publication<\/h2>/
    );
    const order = ['ui-badge neutral', 'Restricted', 'Publish', 'Schedule'].map((x) =>
      out.indexOf(x)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > 0)).toBe(true);
    // Compact (#87): one action group that wraps, no stacked column of buttons.
    expect(out).toContain('class="ui-actions"');
    expect(out).not.toContain('ui-actions stack');
  });
  it('takes a heading level and a tone', () => {
    const out = html(StatusCard, {
      id: 'p-en',
      title: 'Language en',
      state: 'Published on 28 October 2026',
      tone: 'success',
      level: 3,
    });
    expect(out).toContain('<h3 id="p-en-title" class="ui-status-card-title">Language en</h3>');
    expect(out).toContain('<span class="ui-badge success">Published on 28 October 2026</span>');
    expect(out).not.toContain('ui-actions');
  });
});
