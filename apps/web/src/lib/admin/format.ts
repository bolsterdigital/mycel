// Formatting the media admin shares between its overview and detail pages: a byte count in the
// largest unit that keeps it above one, in the reader's locale. Rejected: a copy per page, which
// is how the two pages would start showing one file's size differently.
export function formatBytes(n: number, locale: string): string {
  const [unit, d] =
    n >= 1024 ** 3
      ? (['gigabyte', 1024 ** 3] as const)
      : n >= 1024 ** 2
        ? (['megabyte', 1024 ** 2] as const)
        : (['kilobyte', 1024] as const);
  return new Intl.NumberFormat(locale, { style: 'unit', unit, maximumFractionDigits: 1 }).format(
    n / d
  );
}
