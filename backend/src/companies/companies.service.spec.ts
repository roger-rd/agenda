import type { Repository } from 'typeorm';
import { Company } from '../persistence/entities/company.entity';
import { decodeCursor, encodeCursor } from './companies-cursor';
import { CompaniesService, LIST_ACCESSIBLE_COMPANIES_SQL, LIST_COMPANIES_SQL } from './companies.service';
import type { CompaniesScope } from './companies-scope';

const rows = Array.from({ length: 5 }, (_, index) => ({ id: `01900000-0000-7000-8000-00000000000${index}`,
  name: `Empresa ${index}`, name_key: `empresa ${index}`, color: '#112233', version: 1, organization_id: 'privada' }));
describe('consultas de empresas sin conexión', () => {
  const query = jest.fn();
  const service = new CompaniesService({ query } as unknown as Repository<Company>);
  beforeEach(() => { query.mockReset(); });
  it('fija ambas consultas completas y sus parámetros de aislamiento', () => {
    expect(LIST_COMPANIES_SQL).toBe('SELECT c.id, c.name, c.color, c.version, c.name_key FROM public.companies c WHERE c.organization_id = $1 AND ($2::text IS NULL OR (c.name_key, c.id) > ($2::text, $3::uuid)) ORDER BY c.name_key, c.id LIMIT $4');
    expect(LIST_ACCESSIBLE_COMPANIES_SQL).toBe('SELECT c.id, c.name, c.color, c.version, c.name_key FROM public.companies c JOIN public.company_accesses a ON a.company_id = c.id AND a.organization_id = c.organization_id WHERE c.organization_id = $1 AND a.organization_id = $1 AND a.membership_id = $5 AND ($2::text IS NULL OR (c.name_key, c.id) > ($2::text, $3::uuid)) ORDER BY c.name_key, c.id LIMIT $4');
  });
  it.each(['community_manager', 'worker', 'client'] as const)('recorre todas las páginas de %s sin omitir ni repetir', async role => {
    const scope: CompaniesScope = { role, organizationId: "organización-'privada", membershipId: 'membresía-privada' };
    query.mockResolvedValueOnce(rows.slice(0, 3)).mockResolvedValueOnce(rows.slice(2, 5)).mockResolvedValueOnce(rows.slice(4));
    const received: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await service.list(scope, { limit: 2, cursor });
      const previous = cursor ? decodeCursor(cursor) : null;
      const sql = role === 'community_manager' ? LIST_COMPANIES_SQL : LIST_ACCESSIBLE_COMPANIES_SQL;
      expect(query).toHaveBeenNthCalledWith(page + 1, sql, [scope.organizationId, previous?.nameKey ?? null,
        previous?.id ?? null, 3, ...(role === 'community_manager' ? [] : [scope.membershipId])]);
      expect(sql).toContain('c.organization_id = $1');
      if (role !== 'community_manager') {
        expect(sql).toContain('JOIN public.company_accesses'); expect(sql).toContain('a.organization_id = $1');
        expect(sql).toContain('a.membership_id = $5');
      }
      expect(sql).not.toContain(scope.organizationId); expect(sql).not.toContain(scope.membershipId);
      expect(result.items).toEqual(rows.slice(page * 2, page * 2 + 2).map(({ id, name, color, version }) => ({ id, name, color, version })));
      received.push(...result.items.map(item => item.id));
      if (page < 2) expect(result.nextCursor).toBe(encodeCursor({ nameKey: rows[page * 2 + 1].name_key, id: rows[page * 2 + 1].id }));
      else expect(result.nextCursor).toBeNull();
      cursor = result.nextCursor ?? undefined;
    }
    expect(received).toEqual(rows.map(row => row.id));
  });
  it('sin accesos devuelve lista vacía', async () => {
    query.mockResolvedValue([]);
    expect(await service.list({ role: 'worker', organizationId: 'o', membershipId: 'm' }, { limit: 20 }))
      .toEqual({ items: [], nextCursor: null });
  });
  it('una página exacta no anuncia otra y no traduce errores de base de datos', async () => {
    const scope: CompaniesScope = { role: 'client', organizationId: 'o', membershipId: 'm' };
    query.mockResolvedValue(rows.slice(0, 2));
    expect((await service.list(scope, { limit: 2 })).nextCursor).toBeNull();
    const failure = { severity: 'ERROR', code: '08006' };
    query.mockRejectedValue(failure);
    await expect(service.list(scope, { limit: 2 })).rejects.toBe(failure);
  });
});
