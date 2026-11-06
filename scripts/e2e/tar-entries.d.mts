// Types for tar-entries.mjs, so the export e2e that lists an archive is typechecked
// (apps/web/e2e/tsconfig.json). Rejected: allowJs over scripts/, as for spec-check.d.mts.
export declare const MAX_ENTRIES: number;
export declare function tarEntries(file: string): Promise<string[]>;
