import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';

@Module({})
class TestDatabaseModule {}
import { Test } from '@nestjs/testing';

import { setupHttpLogging } from './logging/setup-http-logging';

const originalEnv = { ...process.env };
beforeAll(() => {
  process.env = { NODE_ENV: 'test', DATABASE_NAME: 'agenda_test', DATABASE_USER: 'agenda_test_app',
    DATABASE_PASSWORD: 'fake-password-for-unit-tests-0001' };
});
afterAll(() => { process.env = originalEnv; });

describe('AppModule', () => {
  it('compila el módulo y crea una aplicación sin abrir puertos', async () => {
    const { AppModule } = await import('./app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).overrideModule(DatabaseModule).useModule(TestDatabaseModule).compile();

    const app = moduleRef.createNestApplication();
    try {
      await setupHttpLogging(app);
      await app.init();
      expect(moduleRef).toBeDefined();
      expect(app).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
