import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Clock, SystemClock } from './clock';
import { ClockModule } from './clock.module';

@Module({ imports: [ClockModule], providers: [{ provide: 'reloj', inject: [Clock], useFactory: (clock: Clock) => clock }] })
class ConsumerModule {}

describe('Clock', () => {
  it('devuelve una fecha válida entre las lecturas del reloj del sistema', () => {
    const start = Date.now();
    const date = new SystemClock().now();
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).toBeGreaterThanOrEqual(start);
    expect(date.getTime()).toBeLessThanOrEqual(Date.now());
  });
  it('exporta Clock y lo resuelve sin ser global ni abrir sockets', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConsumerModule] }).compile();
    try {
      expect(moduleRef.get('reloj')).toBeInstanceOf(SystemClock);
      expect(moduleRef.get('reloj')).toBe(moduleRef.get(Clock));
      expect(Reflect.getMetadata('__module:global__', ClockModule)).toBeUndefined();
    } finally { await moduleRef.close(); }
  });
  it('permite sustituir el reloj por una subclase falsa', async () => {
    class FakeClock extends Clock {
      now(): Date { return new Date('2026-01-01T00:00:00.000Z'); }
    }
    const moduleRef = await Test.createTestingModule({ imports: [ConsumerModule] })
      .overrideProvider(Clock).useClass(FakeClock).compile();
    try {
      expect(moduleRef.get<Clock>('reloj').now()).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    } finally { await moduleRef.close(); }
  });
});
