import 'reflect-metadata';
import { createValidationPipe } from '../common/http/validation.pipe';
import { UpdateCompanyDto } from './update-company.dto';

const transform = (body: unknown) => createValidationPipe().transform(body, { type: 'body', metatype: UpdateCompanyDto });
describe('DTO de edición de empresa', () => {
  it.each([{ version: 1 }, { version: 2147483647, name: 'Empresa' }, { version: 1, color: '#AABBCC' }])('conserva tipos y campos omitidos %p', async body => {
    await expect(transform(body)).resolves.toEqual(body);
  });
  it.each([undefined, null, 0, -1, 1.5, '1', 2147483648])('rechaza versión %p sin convertirla', async version => {
    await expect(transform({ version, name: 'Empresa' })).rejects.toMatchObject({ field: 'version' });
  });
  it.each(['name', 'color'])('rechaza null y tipos incorrectos en %s', async field => {
    for (const value of [null, 1, {}, 'a'.repeat(field === 'name' ? 201 : 21)]) {
      await expect(transform({ version: 1, [field]: value })).rejects.toMatchObject({ field });
    }
  });
  it.each(['organizationId', 'id', 'nameKey', 'role', 'companyId'])('rechaza %s sin field', async key => {
    await expect(transform({ version: 1, name: 'Empresa', [key]: 'ajeno' })).rejects.toMatchObject({ field: undefined });
  });
  it('declara versión antes de nombre y color', async () => {
    await expect(transform({ version: null, name: null, color: null })).rejects.toMatchObject({ field: 'version' });
  });
});
