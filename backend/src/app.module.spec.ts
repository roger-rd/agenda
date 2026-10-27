import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('AppModule', () => {
  it('compila el módulo y crea una aplicación sin abrir puertos', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    try {
      expect(moduleRef).toBeDefined();
      expect(app).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
