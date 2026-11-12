import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DEFAULT_TRANSACTION_TIMEOUTS } from '../database/transactions/transaction-timeouts';

export abstract class TransactionRunner {
  abstract run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T>;
}

function integerTimeout(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Timeout inválido.');
  return String(value);
}

@Injectable()
export class DataSourceTransactionRunner extends TransactionRunner {
  constructor(private readonly dataSource: DataSource) { super(); }

  run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    // Aislamiento por defecto (READ COMMITTED), sin reintentos.
    return this.dataSource.transaction(async manager => {
      // SET no admite parámetros de enlace: interpolar solo enteros validados.
      await manager.query(`SET LOCAL lock_timeout = ${integerTimeout(DEFAULT_TRANSACTION_TIMEOUTS.lockMs)}`);
      await manager.query(`SET LOCAL statement_timeout = ${integerTimeout(DEFAULT_TRANSACTION_TIMEOUTS.statementMs)}`);
      return work(manager);
    });
  }
}
