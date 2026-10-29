// The HTTP API of the run: scripts/e2e.mjs starts it at `E2E_API_URL` with `MYCEL_API_KEY`, a key
// of tenant probe. Specs seed and read through it, so the address, the key and the check that a
// call succeeded live here once instead of in a helper per describe block.
// Rejected: a Playwright fixture with its own request context, which would hide which spec talks
// to the API and add a second base URL next to the app's.

import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';

/** The API's base URL; skips the current test when the spec runs outside scripts/e2e.mjs. */
export function requireApi(): string {
  const url = process.env['E2E_API_URL'];
  test.skip(!url, 'run through scripts/e2e.mjs');
  return url!;
}

/** `POST /v1/<name>` with the seed key of tenant probe, as it answered. */
export const postUseCase = (
  request: APIRequestContext,
  name: string,
  data: unknown
): Promise<APIResponse> =>
  request.post(`${requireApi()}/v1/${name}`, {
    headers: { authorization: `Bearer ${process.env['MYCEL_API_KEY']}` },
    data,
  });

/** A use case that must succeed, its JSON body; a refusal fails the test with the body. */
export async function callApi<T = any>(
  request: APIRequestContext,
  name: string,
  data: unknown
): Promise<T> {
  const response = await postUseCase(request, name, data);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
