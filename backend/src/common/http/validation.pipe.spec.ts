import { IsString } from 'class-validator';
import { createValidationPipe } from './validation.pipe';
class Input { @IsString() title!: string; }
it('whitelist estricta y errores seguros', async () => {
  const pipe = createValidationPipe();
  const meta = { type: 'body' as const, metatype: Input };
  await expect(pipe.transform({ title: 'ok' }, meta)).resolves.toBeInstanceOf(Input);
  await expect(pipe.transform({ title: 'ok', unknown: 'secret' }, meta)).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400, field: undefined });
});

it('field procede de metadata del DTO', async () => {
  await expect(createValidationPipe().transform({ title: 7 }, { type: 'body', metatype: Input }))
    .rejects.toMatchObject({ code: 'invalid_input', field: 'title' });
});
