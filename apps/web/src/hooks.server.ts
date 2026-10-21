// Sets <html lang> per response from the locale the route negotiated (ADR 007), so screen
// readers pronounce the page in the right language. Routes write `event.locals.lang`.
import type { Handle } from '@sveltejs/kit/hooks';

export const handle: Handle = ({ event, resolve }) =>
  resolve(event, {
    transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.lang ?? 'en'),
  });
