import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../shared/domain/money.js';
import { InsufficientBalanceError, InvalidWalletError, Wallet } from './wallet.js';
import { InvalidLedgerEntryError, LedgerDirection } from './wallet-ledger-entry.js';

describe('Wallet', () => {
  test('deve abrir uma carteira com saldo e versão inicial', () => {
    const initialBalance = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance,
    });

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.equals(initialBalance)).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toBeInstanceOf(Date);
    expect(wallet.updatedAt.getTime()).toBe(
      wallet.createdAt.getTime(),
    );
  });

  test('deve permitir abertura com saldo zero', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('deve obter a moeda a partir do saldo inicial', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('USD'),
    });

    expect(wallet.currency).toBe('USD');
    expect(wallet.balance.currency).toBe('USD');
  });

  test('deve rejeitar abertura com saldo negativo', () => {
    const negativeBalance = Money.from({
      amount: '10.00',
      currency: 'BRL',
    }).negate();

    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: negativeBalance,
      }),
    ).toThrow(InvalidWalletError);
  });

  test.each(['', '   '])(
    'deve rejeitar o identificador de carteira vazio "%s"',
    (id) => {
      expect(() =>
        Wallet.open({
          id,
          playerId: 'player-1',
          initialBalance: Money.zero('BRL'),
        }),
      ).toThrow(InvalidWalletError);
    },
  );

  test.each(['', '   '])(
    'deve rejeitar o identificador de jogador vazio "%s"',
    (playerId) => {
      expect(() =>
        Wallet.open({
          id: 'wallet-1',
          playerId,
          initialBalance: Money.zero('BRL'),
        }),
      ).toThrow(InvalidWalletError);
    },
  );

  test('deve proteger as datas contra alterações externas', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });

    const createdAt = wallet.createdAt.getTime();
    const updatedAt = wallet.updatedAt.getTime();

    wallet.createdAt.setTime(0);
    wallet.updatedAt.setTime(0);

    expect(wallet.createdAt.getTime()).toBe(createdAt);
    expect(wallet.updatedAt.getTime()).toBe(updatedAt);
  });

  test('deve reconstruir o estado de uma carteira existente', () => {
    const balance = Money.from({
      amount: '75.50',
      currency: 'BRL',
    });

    const createdAt = new Date('2026-01-01T10:00:00.000Z');
    const updatedAt = new Date('2026-01-02T15:00:00.000Z');

    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance,
      version: 7,
      createdAt,
      updatedAt,
    });

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.equals(balance)).toBe(true);

    // Preserva a versão existente, em vez de reiniciar em 1.
    expect(wallet.version).toBe(7);

    // Preserva os instantes originais.
    expect(wallet.createdAt.getTime()).toBe(createdAt.getTime());
    expect(wallet.updatedAt.getTime()).toBe(updatedAt.getTime());
  });

  test('deve copiar as datas recebidas na reidratação', () => {
    const createdAt = new Date('2026-01-01T10:00:00.000Z');
    const updatedAt = new Date('2026-01-02T15:00:00.000Z');

    const originalCreatedAt = createdAt.getTime();
    const originalUpdatedAt = updatedAt.getTime();

    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: Money.zero('BRL'),
      version: 3,
      createdAt,
      updatedAt,
    });

    // Tenta alterar o estado por meio dos objetos fornecidos.
    createdAt.setTime(0);
    updatedAt.setTime(0);

    expect(wallet.createdAt.getTime()).toBe(originalCreatedAt);
    expect(wallet.updatedAt.getTime()).toBe(originalUpdatedAt);
  });

  test('deve proteger as datas retornadas após a reidratação', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: Money.zero('USD'),
      version: 2,
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      updatedAt: new Date('2026-01-02T15:00:00.000Z'),
    });

    const originalCreatedAt = wallet.createdAt.getTime();
    const originalUpdatedAt = wallet.updatedAt.getTime();

    // Tenta alterar o estado pelas datas retornadas pelos getters.
    wallet.createdAt.setTime(0);
    wallet.updatedAt.setTime(0);

    expect(wallet.createdAt.getTime()).toBe(originalCreatedAt);
    expect(wallet.updatedAt.getTime()).toBe(originalUpdatedAt);
  });

  test('deve debitar e retornar o lançamento correspondente', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    const at = new Date('2026-10-21T15:00:00.000Z');

    const entry = wallet.debit({
      ledgerEntryId: 'entry-1',
      transactionId: 'transaction-1',
      money: Money.from({
        amount: '25.00',
        currency: 'BRL',
      }),
      at,
    });

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.getTime()).toBe(at.getTime());

    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe('transaction-1');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test('deve creditar e retornar o lançamento correspondente', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });

    const entry = wallet.credit({
      ledgerEntryId: 'entry-1',
      transactionId: 'transaction-1',
      money: Money.from({
        amount: '40.00',
        currency: 'BRL',
      }),
      at: new Date(),
    });

    expect(wallet.balance.toJSON().amount).toBe('40.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.isZero()).toBe(true);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test('deve permitir debitar exatamente o saldo disponível', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '25.00',
        currency: 'BRL',
      }),
    });

    const entry = wallet.debit({
      ledgerEntryId: 'entry-1',
      transactionId: 'transaction-1',
      money: wallet.balance,
      at: new Date(),
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('deve preservar o estado quando o saldo for insuficiente', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '10.00',
        currency: 'BRL',
      }),
    });

    const originalBalance = wallet.balance;
    const originalUpdatedAt = wallet.updatedAt.getTime();

    expect(() =>
      wallet.debit({
        ledgerEntryId: 'entry-1',
        transactionId: 'transaction-1',
        money: Money.from({
          amount: '20.00',
          currency: 'BRL',
        }),
        at: new Date(),
      }),
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance).toBe(originalBalance);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.getTime()).toBe(originalUpdatedAt);
  });

  test('deve rejeitar crédito e débito em outra moeda', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });

    const props = {
      ledgerEntryId: 'entry-1',
      transactionId: 'transaction-1',
      money: Money.from({
        amount: '10.00',
        currency: 'USD',
      }),
      at: new Date(),
    };

    expect(() => wallet.credit(props)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(props)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('deve rejeitar movimentações de valor zero ou negativo', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });

    const props = {
      ledgerEntryId: 'entry-1',
      transactionId: 'transaction-1',
      at: new Date(),
    };

    const values = [
      Money.zero('BRL'),
      Money.from({
        amount: '1.00',
        currency: 'BRL',
      }).negate(),
    ];

    for (const money of values) {
      expect(() => wallet.credit({ ...props, money })).toThrow(
        InvalidWalletError,
      );

      expect(() => wallet.debit({ ...props, money })).toThrow(
        InvalidWalletError,
      );
    }

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('deve preservar o estado se a criação do ledger falhar', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });

    const originalBalance = wallet.balance;
    const originalUpdatedAt = wallet.updatedAt.getTime();

    expect(() =>
      wallet.credit({
        ledgerEntryId: '',
        transactionId: 'transaction-1',
        money: Money.from({
          amount: '10.00',
          currency: 'BRL',
        }),
        at: new Date(),
      }),
    ).toThrow(InvalidLedgerEntryError);

    expect(wallet.balance).toBe(originalBalance);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.getTime()).toBe(originalUpdatedAt);
  });
});