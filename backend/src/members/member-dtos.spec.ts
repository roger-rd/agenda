import { createValidationPipe } from '../common/http/validation.pipe';
import { ListMembersQuery } from './list-members.query';
import { UpdateAccessesDto } from './update-accesses.dto';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const body = (value: unknown) => createValidationPipe().transform(value, { type: 'body', metatype: UpdateAccessesDto });
const query = (value: unknown) => createValidationPipe().transform(value, { type: 'query', metatype: ListMembersQuery });
const valid = { version: 1, companyIds: [uuid(1)] };

describe('UpdateAccessesDto', () => {
  it('acepta la forma válida y la lista vacía', async () => {
    await expect(body({ ...valid })).resolves.toBeInstanceOf(UpdateAccessesDto);
    await expect(body({ version: 7, companyIds: [] })).resolves.toMatchObject({ version: 7, companyIds: [] });
    await expect(body({ version: 1, companyIds: Array.from({ length: 50 }, (_, i) => uuid(i + 1)) })).resolves.toBeInstanceOf(UpdateAccessesDto);
  });
  it.each([undefined, null, 0, -1, 1.5, 2147483648, '1', true])('400 con version %p', async version => {
    await expect(body({ ...valid, version })).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400, field: 'version' });
  });
  it.each([[undefined], [null], ['x'], [{}], [[5]], [[null]], [['a'.repeat(37)]], [Array.from({ length: 51 }, (_, i) => uuid(i + 1))]])('400 con companyIds %p', async companyIds => {
    await expect(body({ ...valid, companyIds })).rejects.toMatchObject({ code: 'invalid_input', field: 'companyIds' });
  });
  it.each(['organizationId', 'role', 'membershipId', 'userId', 'updatedAt', 'deactivatedAt'])('400 por la propiedad desconocida %s', async key => {
    await expect(body({ ...valid, [key]: 'x' })).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400 });
  });
});

describe('ListMembersQuery: filtros y paginación por defecto', () => {
  it('vacía: limit 20, status active y sin rol', async () => {
    const dto = await query({});
    expect(dto).toMatchObject({ limit: 20, status: 'active' });
    expect((dto as ListMembersQuery).role).toBeUndefined();
    expect((dto as ListMembersQuery).cursor).toBeUndefined();
  });
  it('acepta límites 1 y 100, cursor, roles y estados cerrados', async () => {
    await expect(query({ limit: '1' })).resolves.toMatchObject({ limit: 1 });
    await expect(query({ limit: '100', cursor: 'abc', role: 'client', status: 'all' })).resolves.toMatchObject({ limit: 100, role: 'client', status: 'all' });
    for (const role of ['community_manager', 'worker', 'client']) await expect(query({ role })).resolves.toMatchObject({ role });
    for (const status of ['active', 'deactivated', 'all']) await expect(query({ status })).resolves.toMatchObject({ status });
  });
  it.each([[{ role: 'admin' }, 'role'], [{ role: '' }, 'role'], [{ role: null }, 'role'], [{ status: 'inactive' }, 'status'], [{ status: '' }, 'status'], [{ status: null }, 'status'],
    [{ limit: '0' }, 'limit'], [{ limit: '101' }, 'limit'], [{ limit: 'x' }, 'limit'], [{ cursor: 'a'.repeat(513) }, 'cursor']])('400 con %p', async (value, field) => {
    await expect(query(value)).rejects.toMatchObject({ code: 'invalid_input', field });
  });
  it('rechaza parámetros desconocidos, también la organización', async () => {
    await expect(query({ organizationId: uuid(1) })).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400 });
  });
});
