// Component tests of the admin's shared components (brief #56 § D): each is rendered with
// `svelte/server`, as the admin serves it (no client JavaScript), and checked for the semantics a
// screen relies on: native elements, label and description wiring, landmarks and current-page
// marks, and the localised copy the component brings itself. Layout at 320 CSS px and 200% text
// and axe run in the browser, over the catalogue (e2e/admin-ui.spec.ts).
import { describe, expect, it } from 'vitest';
import { createRawSnippet, type Component } from 'svelte';
import { render } from 'svelte/server';
import {
  Actions,
  Badge,
  Breadcrumb,
  Button,
  Card,
  CardGrid,
  Checkbox,
  Choices,
  DetailPage,
  Dialog,
  EditPage,
  EmptyState,
  Field,
  Fieldset,
  FileDrop,
  FormPage,
  MetaList,
  Notice,
  OverviewPage,
  PageHeader,
  Pagination,
  Panel,
  Select,
  SettingsPage,
  SettingsSection,
  SubNav,
  SystemState,
  Table,
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
    expect(out).toContain('<label for="title">Title<span class="ui-required"> (verplicht)</span>');
    expect(out).toContain('id="title-hint"');
    expect(out).toContain('id="title-error"');
    expect(out).toMatch(/<input[^>]*aria-describedby="title-hint title-error"/);
    expect(out).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(out).toMatch(/<input[^>]*required/);
    expect(out).toMatch(/<input[^>]*name="title"/);
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
      /checked|aria-describedby/
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
    expect(out).toContain('<label for="kind">Type</label>');
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
    expect(out).toContain('<legend>Who can see this</legend>');
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
