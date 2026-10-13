import type { ConnectionDatabase } from './db/index.js';
import { parseDbTimestamp } from './db/time.js';
import type { Firm, FirmRecord, FirmUpdate, NewFirm } from './db/models.js';

/** The firm every row belongs to on a single-firm installation. */
export const DEFAULT_FIRM_ID = 1;

/** "Acme CPA, LLC" → "acme-cpa-llc". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'firm';
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

function toFirm(record: FirmRecord): Firm {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    status: record.status,
    plan: record.plan,
    companyLimit: record.company_limit,
    createdAt: parseDbTimestamp(record.created_at),
    updatedAt: parseDbTimestamp(record.updated_at),
  };
}

/**
 * Firms are the tenants: a CPA firm with its own QuickBooks connections and
 * team. Nothing in a firm is visible to another firm; the platform operator
 * (master key) can see across them.
 */
export class FirmService {
  constructor(private db: ConnectionDatabase) {}

  async create(input: NewFirm): Promise<Firm> {
    const name = input.name?.trim();
    if (!name) throw new Error('Firm name is required');
    let slug = input.slug?.trim().toLowerCase() || slugify(name);
    if (input.slug && !isValidSlug(slug)) {
      throw new Error('Slug must be 2-63 characters: lowercase letters, digits and dashes');
    }
    if (input.slug && (await this.db.getFirmBySlug(slug))) {
      throw new Error(`Slug "${slug}" is already taken`);
    }
    if (!input.slug) {
      // Derived slugs get a numeric suffix rather than failing.
      const base = slug;
      for (let n = 2; await this.db.getFirmBySlug(slug); n++) slug = `${base}-${n}`;
    }
    if (input.companyLimit != null && (!Number.isInteger(input.companyLimit) || input.companyLimit < 0)) {
      throw new Error('companyLimit must be a non-negative integer');
    }
    const id = await this.db.insertFirm({
      name,
      slug,
      plan: input.plan ?? null,
      companyLimit: input.companyLimit ?? null,
    });
    return (await this.get(id))!;
  }

  async get(id: number): Promise<Firm | null> {
    const record = await this.db.getFirmById(id);
    return record ? toFirm(record) : null;
  }

  async getBySlug(slug: string): Promise<Firm | null> {
    const record = await this.db.getFirmBySlug(slug.trim().toLowerCase());
    return record ? toFirm(record) : null;
  }

  async list(): Promise<Firm[]> {
    return (await this.db.getAllFirms()).map(toFirm);
  }

  async update(id: number, fields: FirmUpdate): Promise<Firm | null> {
    if (!(await this.db.getFirmById(id))) return null;
    if (fields.name !== undefined && !fields.name.trim()) throw new Error('Firm name cannot be empty');
    let slug = fields.slug;
    if (slug !== undefined) {
      slug = slug.trim().toLowerCase();
      if (!isValidSlug(slug)) throw new Error('Slug must be 2-63 characters: lowercase letters, digits and dashes');
      const holder = await this.db.getFirmBySlug(slug);
      if (holder && holder.id !== id) throw new Error(`Slug "${slug}" is already taken`);
    }
    if (fields.companyLimit != null && (!Number.isInteger(fields.companyLimit) || fields.companyLimit < 0)) {
      throw new Error('companyLimit must be a non-negative integer');
    }
    await this.db.updateFirm(id, { ...fields, name: fields.name?.trim(), slug });
    return this.get(id);
  }

  /** How many companies the firm has connected, for limit checks and the operator view. */
  async connectionCount(id: number): Promise<number> {
    return (await this.db.getFirmRealmIds(id)).length;
  }

  /**
   * Whether the firm may connect one more company. Null limit = unlimited.
   * Reconnecting an already-connected company never counts against it.
   */
  async canConnect(id: number, realmId?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const firm = await this.db.getFirmById(id);
    if (!firm) return { ok: false, reason: 'This account no longer exists.' };
    if (firm.status !== 'active') return { ok: false, reason: 'This account is suspended.' };
    if (firm.company_limit == null) return { ok: true };
    const realms = await this.db.getFirmRealmIds(id);
    if (realmId && realms.includes(realmId)) return { ok: true };
    if (realms.length >= firm.company_limit) {
      return {
        ok: false,
        reason: `This account can connect up to ${firm.company_limit} ${firm.company_limit === 1 ? 'company' : 'companies'} and already has ${realms.length}. Disconnect one or upgrade the plan.`,
      };
    }
    return { ok: true };
  }
}
