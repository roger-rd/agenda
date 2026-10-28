import 'reflect-metadata';
import { ConfigModule } from '@nestjs/config';
import { appConfigOptions } from './app.config';

describe('Carga de .env', () => {
  it.each(['development', 'production', undefined])('permite .env en %s', env => {
    expect(appConfigOptions(env).ignoreEnvFile).toBe(false);
  });
  it('test no consulta el archivo de entorno', async () => {
    const parser = jest.fn(() => { throw new Error('No debe leer archivos en test'); });
    await ConfigModule.forRoot({ ...appConfigOptions('test'), envFilePath: 'package.json', parser });
    expect(parser).not.toHaveBeenCalled();
  });
});
