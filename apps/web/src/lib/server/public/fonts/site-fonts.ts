// Serving an uploaded face (MY-302): the address names role, weight, style and the start of the
// bytes' hash (`siteFontFile`), so the response is immutable and a replaced face is a new URL.
// An address that names no current face is a 404, never an older file. Shared by the public
// route and the preview, which differ only in who may read and how long a response is kept.
// Rejected: a blob URL per face (the bytes live in the tenant's rows, under RLS, like the
// wordmark) and trusting the name alone (the hash in the row is compared before serving).
import { SiteFontRole, SiteFontStyle, siteFontFile, type TransactionContext } from '@mycel/core';

const FILE = /^(heading|body)-([1-9]00)-(normal|italic)-[0-9a-f]{16}\.woff2$/;

/** The face a file name asks for, or null when the name has another shape. */
export function parseSiteFontFile(file: string) {
  const m = FILE.exec(file);
  if (!m) return null;
  return {
    role: SiteFontRole.parse(m[1]),
    weight: Number(m[2]),
    style: SiteFontStyle.parse(m[3]),
  };
}

/** The bytes of the face `file` names, when it is the current face; otherwise null. */
export async function siteFontBytes(
  ctx: Pick<TransactionContext, 'siteFonts'>,
  file: string
): Promise<Uint8Array | null> {
  const want = parseSiteFontFile(file);
  if (!want) return null;
  const face = await ctx.siteFonts.face(want.role, want.weight, want.style);
  if (!face || siteFontFile(want.role, { ...want, sha256: face.sha256 }) !== file) return null;
  return face.bytes;
}
