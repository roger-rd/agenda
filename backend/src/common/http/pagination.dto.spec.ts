import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaginationQueryDto } from './pagination.dto';
it.each([1, 100])('acepta límite %s y cursor opaco de 512 caracteres', async limit => {
  const dto = plainToInstance(PaginationQueryDto, { limit: String(limit), cursor: 'x'.repeat(512) });
  expect(dto.limit).toBe(limit); expect(await validate(dto)).toEqual([]);
});
it('default 20', () => expect(new PaginationQueryDto().limit).toBe(20));
