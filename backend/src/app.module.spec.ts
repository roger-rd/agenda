import 'reflect-metadata';
import { ConstraintRegistry } from './database/errors/constraint-registry';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';

@Module({ providers: [ConstraintRegistry], exports: [ConstraintRegistry] })
class TestDatabaseModule {}
import { Test } from '@nestjs/testing';

import { configureHttpApp } from './common/http/configure-http-app';

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
      await configureHttpApp(app);
      await app.init();
      expect(moduleRef).toBeDefined();
      expect(app).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
