// Tenants are platform data, not tenant-owned data (ADR 002 rule 4): the directory is a read-only
// lookup fronts use to turn a hostname or route into a tenant id before building a Principal.

export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  locales: string[];
}

export interface TenantDirectory {
  findById(id: string): Promise<TenantInfo | null>;
  findBySlug(slug: string): Promise<TenantInfo | null>;
}
