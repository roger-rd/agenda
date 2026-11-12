import { createValidationPipe } from '../common/http/validation.pipe';
import { RegisterRequestDto } from './register.dto';

const input = { email: ' ana@example.test ', password: '  password with spaces  ', name: ' Ana ', organizationName: ' Equipo ' };
const transform = (value: object) => createValidationPipe().transform(value, { type: 'body', metatype: RegisterRequestDto });

it('el DTO conserva todos los campos literalmente, sin trim ni normalización', async () => {
  expect(await transform(input)).toEqual(input);
});
it.each([['email', 254], ['password', 1024], ['name', 200], ['organizationName', 200]] as const)('valida presencia, tipo y límite grueso de %s', async (field, max) => {
  const missing: Record<string, unknown> = { ...input }; delete missing[field];
  for (const value of [missing, { ...input, [field]: 42 }, { ...input, [field]: 'x'.repeat(max + 1) }]) {
    await expect(transform(value)).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400, field });
  }
  await expect(transform({ ...input, [field]: 'x'.repeat(max) })).resolves.toHaveProperty(field, 'x'.repeat(max));
});
it('elige el primer campo declarado y omite field si existe una propiedad desconocida', async () => {
  await expect(transform({})).rejects.toMatchObject({ field: 'email' });
  await expect(transform({ extra: true })).rejects.toMatchObject({ code: 'invalid_input', field: undefined });
});
