import { createValidationPipe } from '../common/http/validation.pipe';
import { CreateInvitationDto } from './create-invitation.dto';
import { ListInvitationsQuery } from './list-invitations.query';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const body = (value: unknown) => createValidationPipe().transform(value, { type: 'body', metatype: CreateInvitationDto });
const query = (value: unknown) => createValidationPipe().transform(value, { type: 'query', metatype: ListInvitationsQuery });
const valid = { email: 'ana@example.com', role: 'worker', companyIds: [uuid(1)] };

describe('CreateInvitationDto', () => {
  it('acepta la forma válida y aplica 7 días por omisión', async () => {
    const dto = await body({ ...valid });
    expect(dto).toBeInstanceOf(CreateInvitationDto);
    expect(dto).toMatchObject({ ...valid, validityDays: 7 });
  });
  it.each([1, 7, 30])('acepta validityDays %i', async days => {
    await expect(body({ ...valid, validityDays: days })).resolves.toMatchObject({ validityDays: days });
  });
  it.each([null, 0, 2, 31, '7', 7.5, true, [], {}])('rechaza validityDays %p', async value => {
    await expect(body({ ...valid, validityDays: value })).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400, field: 'validityDays' });
  });
  it.each(['worker', 'client'])('acepta el rol %s', async role => {
    await expect(body({ ...valid, role })).resolves.toMatchObject({ role });
  });
  it.each(['community_manager', 'admin', '', null, 7, undefined])('rechaza el rol %p', async role => {
    await expect(body({ ...valid, role })).rejects.toMatchObject({ code: 'invalid_input', field: 'role' });
  });
  it.each([undefined, null, 7, {}, 'a'.repeat(201)])('rechaza el correo %p', async email => {
    await expect(body({ ...valid, email })).rejects.toMatchObject({ code: 'invalid_input', field: 'email' });
  });
  it('exige entre 1 y 50 empresas', async () => {
    await expect(body({ ...valid, companyIds: [] })).rejects.toMatchObject({ field: 'companyIds' });
    await expect(body({ ...valid, companyIds: Array.from({ length: 51 }, (_, i) => uuid(i + 1)) })).rejects.toMatchObject({ field: 'companyIds' });
    await expect(body({ ...valid, companyIds: Array.from({ length: 50 }, (_, i) => uuid(i + 1)) })).resolves.toBeInstanceOf(CreateInvitationDto);
    await expect(body({ email: valid.email, role: 'worker' })).rejects.toMatchObject({ field: 'companyIds' });
  });
  it.each([[[7]], [[null]], ['x'], [{}], [[uuid(1), 5]], [['a'.repeat(37)]]])('rechaza companyIds %p', async ids => {
    await expect(body({ ...valid, companyIds: ids })).rejects.toMatchObject({ code: 'invalid_input', field: 'companyIds' });
  });
  it('rechaza campos desconocidos, también los que parecen de otra organización o de estado', async () => {
    for (const extra of [{ organizationId: uuid(9) }, { status: 'accepted' }, { token: 'x' }, { expiresAt: '2030-01-01T00:00:00.000Z' }, { createdByMembershipId: uuid(9) }]) {
      await expect(body({ ...valid, ...extra })).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400 });
    }
  });
  it('no incluye el valor rechazado en el error', async () => {
    const error = await body({ ...valid, email: 'a'.repeat(201) }).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain('a'.repeat(50));
  });
});

describe('ListInvitationsQuery', () => {
  it('acepta consulta vacía con limit 20 y opcionales', async () => {
    await expect(query({})).resolves.toMatchObject({ limit: 20 });
    await expect(query({ limit: '50', status: 'open', cursor: 'abc' })).resolves.toMatchObject({ limit: 50, status: 'open', cursor: 'abc' });
  });
  it.each(['open', 'accepted', 'revoked', 'expired'])('acepta el estado %s', async status => {
    await expect(query({ status })).resolves.toMatchObject({ status });
  });
  it.each(['', 'OPEN', 'pending', 'used', 7, null])('rechaza el estado %p', async status => {
    await expect(query({ status })).rejects.toMatchObject({ code: 'invalid_input', field: 'status' });
  });
  it.each([{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { limit: '-1' }, { cursor: 'a'.repeat(513) }, { organizationId: uuid(1) }, { token: 'x' }])('rechaza %p', async value => {
    await expect(query(value)).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400 });
  });
});
