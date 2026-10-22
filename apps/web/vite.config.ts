// adapter-node, not adapter-auto: Mycel ships as a Docker image on owned infra (ADR 008);
// nothing here should ever detect a cloud platform and change behaviour. Runes are forced
// for project code so no component silently falls back to legacy reactivity.
//
// Content-Security-Policy (TODO #20c decision 2): SvelteKit generates it per response in nonce
// mode and adds the nonce to the inline bootstrap it writes itself, so `script-src` never needs
// 'unsafe-inline' or 'unsafe-eval' (adding either is a stop, not a fix). Pages without client
// JavaScript (`csr = false`) simply carry no script. Media is served from the site's own origin
// (lib/server/media.ts), hence `img-src 'self'`. The admin tightens `frame-ancestors` to 'none'
// in hooks.server.ts; that is the only change made after SvelteKit. Rejected: `mode: 'hash'`
// (everything is SSR; a nonce also shuts out inline scripts added later) and a policy built by
// hand in `handle`, which would be a second source that drifts from this one.
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      adapter: adapter(),
      csp: {
        mode: 'nonce',
        directives: {
          'default-src': ['self'],
          'script-src': ['self'],
          'style-src': ['self'],
          // SvelteKit's route announcer (kit/src/runtime/components/root.svelte) is the one
          // style attribute any page renders, and only on a page with client JavaScript. This
          // allows exactly that attribute value; after a SvelteKit upgrade that changes it, the
          // nonce test in e2e/signup.spec.ts reports the violation with the new hash.
          'style-src-attr': [
            'unsafe-hashes',
            'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo=',
          ],
          'img-src': ['self', 'data:'],
          'form-action': ['self'],
          'base-uri': ['none'],
          'object-src': ['none'],
          'frame-ancestors': ['self'],
        },
      },
    }),
  ],
});
