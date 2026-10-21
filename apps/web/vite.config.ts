// adapter-node, not adapter-auto: Mycel ships as a Docker image on owned infra (ADR 008);
// nothing here should ever detect a cloud platform and change behaviour. Runes are forced
// for project code so no component silently falls back to legacy reactivity.
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
    }),
  ],
});
