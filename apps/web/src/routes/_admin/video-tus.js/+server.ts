// AdminScript refers to the stable entry point. Vite owns the installed Tus browser bundle,
// so the browser reuses the immutable asset and the repository holds one version.
import { redirect } from '@sveltejs/kit';
import tus from 'tus-js-client/dist/tus.min.js?url';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => redirect(307, tus);
