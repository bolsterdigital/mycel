// A site definition from outside this repository (MY-268): `demo:site --definition <path>` runs a
// definition kept elsewhere, such as a copy of a real client site in a private repository, whose
// content may not be in this public one. The path names a module, or a directory with
// `index.ts`; its files (media, logo) are read from the module's directory. The module's default
// export is the definition, or a function that receives `@mycel/core/testing` and returns it:
// a module outside this checkout cannot resolve `@mycel/*` itself, so the helpers come in as an
// argument. Rejected: copying the definition into `demo-sites/` (puts client content in a
// public repository), and a JSON definition (documents, patterns and navigation are functions of
// the ids the run finds).

import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as testing from '@mycel/core/testing';
import type { SiteDefinition } from '@mycel/core/testing';

export type DefinitionModule = SiteDefinition | ((kit: typeof testing) => SiteDefinition);

export interface LoadedDefinition {
  site: SiteDefinition;
  /** The directory the definition's files are read from, with a trailing slash. */
  files: URL;
}

/** The definition at `path`, relative to `cwd`: a module, or a directory with `index.ts`. */
export async function loadDefinition(path: string, cwd: string): Promise<LoadedDefinition> {
  const absolute = resolve(cwd, path);
  const module = (await stat(absolute)).isDirectory() ? join(absolute, 'index.ts') : absolute;
  const exported = ((await import(pathToFileURL(module).href)) as { default?: DefinitionModule })
    .default;
  const site = typeof exported === 'function' ? exported(testing) : exported;
  if (!site || typeof site.slug !== 'string' || !Array.isArray(site.items))
    throw new Error(`${module}: the default export is not a site definition`);
  return { site, files: pathToFileURL(`${dirname(module)}/`) };
}
