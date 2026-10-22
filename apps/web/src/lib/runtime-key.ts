// The global under which the server keeps its composition root (lib/server/runtime.ts). It is a
// separate, import-free module because the universal `reroute` hook (src/hooks.ts) needs the key
// too and may not import anything under lib/server: SvelteKit's client build refuses that, and
// the hook is bundled for the client even though no page here hydrates.
export const RUNTIME_KEY = Symbol.for('mycel.runtime');
