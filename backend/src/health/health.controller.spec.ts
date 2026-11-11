import { Test } from '@nestjs/testing';
import { HealthModule } from './health.module';
import { HealthController } from './health.controller';
it('construye HealthModule sin DatabaseModule ni DataSource', async () => {
  const module = await Test.createTestingModule({ imports: [HealthModule] }).compile();
  try { expect(module.get(HealthController).health()).toEqual({ status: 'ok' }); }
  finally { await module.close(); }
});
