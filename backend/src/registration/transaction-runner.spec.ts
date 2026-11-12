import { DataSource, EntityManager } from 'typeorm';
import { DataSourceTransactionRunner } from './transaction-runner';

describe('DataSourceTransactionRunner con dobles', () => {
  function setup() {
    const query = jest.fn().mockResolvedValue([]);
    const manager = { query } as unknown as EntityManager;
    const transaction = jest.fn(async (work: (manager: EntityManager) => Promise<unknown>) => work(manager));
    return { query, manager, transaction, runner: new DataSourceTransactionRunner({ transaction } as unknown as DataSource) };
  }
  it('una transacción, dos SET LOCAL y después work con el mismo manager', async () => {
    const { query, manager, transaction, runner } = setup();
    const result = { ok: true };
    const work = jest.fn(async (received: EntityManager) => {
      expect(received).toBe(manager);
      expect(query.mock.calls).toEqual([['SET LOCAL lock_timeout = 2000'], ['SET LOCAL statement_timeout = 5000']]);
      return result;
    });
    expect(await runner.run(work)).toBe(result);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]).toHaveLength(1);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('propaga error sin reintentar', async () => {
    const { transaction, runner } = setup();
    const error = new Error('fallo');
    await expect(runner.run(() => Promise.reject(error))).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('no ejecuta work si falla configurar el timeout', async () => {
    const { query, runner } = setup();
    const error = new Error('timeout');
    query.mockRejectedValueOnce(error);
    const work = jest.fn();
    await expect(runner.run(work)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });
});
