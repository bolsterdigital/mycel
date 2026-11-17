// The site's square icon: its current logo on the theme's light background, at one of the
// sizes the touch icon and the manifest name. Only the current logo version and background answer,
// so the address in a page never serves another mark and may be cached forever. Rendered on
// request from the stored derivative (a few milliseconds, then cached by every hop). Rejected:
// storing a derivative per size at upload, which needs a schema change and goes stale when the
// theme changes; and a platform icon for a site without a logo, a mark the site never chose.
import { anonymousPrincipal } from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, siteTenant } from '#lib/server/site.js';
import { ICON_SIZES, iconPath, siteBrand, siteTheme } from '#lib/server/public/theme.js';
import { shareable } from '#lib/server/http/security-headers.js';
import { refuse } from '#lib/server/http/refuse.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
  const site = requireSite(locals);
  const { logo } = await siteBrand(site);
  if (!logo.active) refuse(404);
  const background = (await siteTheme(site)).colors.light;
  const size = ICON_SIZES.find((s) =>
    iconPath(logo.version, background, s).endsWith(`/${params.file}`)
  );
  if (!size) refuse(404);
  const asset = await runtime().uow.run(
    anonymousPrincipal(siteTenant(site), ['content:read']),
    (ctx) => ctx.brandAssets.get('logo')
  );
  if (!asset.asset || asset.version !== logo.version) refuse(404);
  const png = await runtime().uow.run(
    anonymousPrincipal(siteTenant(site), ['content:read']),
    (ctx) => ctx.brandProcessor.icon(asset.asset!.bytes, size, background)
  );
  return shareable(
    new Response(new Uint8Array(png), {
      headers: {
        'content-type': 'image/png',
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  );
};
