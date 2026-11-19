import 'reflect-metadata';
import { createValidationPipe } from '../common/http/validation.pipe';
import { CreateCompanyDto } from './create-company.dto';

const transform = (body: unknown) => createValidationPipe().transform(body, { type: 'body', metatype: CreateCompanyDto });
describe('DTO de creación de empresa', () => {
  it('deja las reglas finas al servicio', async () => {
    await expect(transform({ name: 'a', color: '#fff' })).resolves.toEqual({ name: 'a', color: '#fff' });
  });
  it.each([{}, { color: '#112233' }, { name: 1, color: '#112233' }, { name: 'a'.repeat(201), color: '#112233' }])('rechaza nombre %p', async body => {
    await expect(transform(body)).rejects.toMatchObject({ field: 'name' });
  });
  it.each([undefined, 1, 'a'.repeat(21)])('rechaza color %p', async color => {
    await expect(transform({ name: 'Empresa', color })).rejects.toMatchObject({ field: 'color' });
  });
  it.each(['organizationId', 'id', 'version', 'nameKey', 'role', 'companyId'])('rechaza propiedad %s sin field', async key => {
    await expect(transform({ name: 'Empresa', color: '#112233', [key]: 'ajeno' })).rejects.toMatchObject({ field: undefined });
  });
});
