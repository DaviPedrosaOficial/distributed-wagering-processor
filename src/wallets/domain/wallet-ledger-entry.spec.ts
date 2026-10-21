import { describe, expect, test } from 'bun:test';
import { Money } from '../../shared/domain/money.js';
import { InvalidLedgerEntryError, LedgerDirection, WalletLedgerEntry, } from './wallet-ledger-entry.js';

describe('WalletLedgerEntry', () => {
  // Função auxiliar: cria valores BRL para os cenários.
  const brl = (amount: string): Money =>
    Money.from({ amount, currency: 'BRL' });

  // Função auxiliar: entrega dados novos em cada chamada.
  const debitProps = () => ({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
  });

  test('deve criar um débito consistente', () => {
    const entry = WalletLedgerEntry.create(debitProps());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
  });

  test('deve criar um crédito consistente', () => {
    const entry = WalletLedgerEntry.create({
      ...debitProps(),
      direction: LedgerDirection.Credit,
      balanceAfter: brl('125.00'),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe('125.00');
  });

  test('deve rejeitar uma equação financeira incorreta', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...debitProps(),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('deve rejeitar um lançamento de valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...debitProps(),
        money: Money.zero('BRL'),
        balanceAfter: brl('100.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('deve rejeitar saldo posterior negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...debitProps(),
        money: brl('125.00'),
        balanceAfter: brl('25.00').negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('deve proteger a data na entrada e na saída', () => {
    const props = debitProps();
    const originalTime = props.createdAt.getTime();

    const entry = WalletLedgerEntry.create(props);

    props.createdAt.setTime(0);
    entry.createdAt.setTime(0);

    expect(entry.createdAt.getTime()).toBe(originalTime);
  });

  test('deve reconstruir um lançamento persistido', () => {
    const props = debitProps();
    const entry = WalletLedgerEntry.rehydrate(props);

    expect(entry.id).toBe(props.id);
    expect(entry.walletId).toBe(props.walletId);
    expect(entry.transactionId).toBe(props.transactionId);
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});