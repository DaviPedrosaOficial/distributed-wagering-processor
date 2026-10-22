import { describe, expect, test } from 'bun:test';
import { Money } from '../../shared/domain/money.js';
import { FailureCode, InvalidWagerTransactionError, InvalidTransactionStateError, WagerTransaction, WagerTransactionKind, WagerTransactionStatus, } from './wager-transaction.js';

describe('WagerTransaction', () => {
    // Dados novos para cada cenário.
    const transactionProps = () => ({
        id: 'transaction-1',
        providerId: 'provider-a',
        externalTransactionId: 'external-1',
        idempotencyKey: 'provider-a:external-1',
        payloadHash: 'payload-hash-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({
        amount: '25.00',
        currency: 'BRL',
        }),
        createdAt: new Date('2026-10-21T15:00:00.000Z'),
    });

    test('deve criar uma aposta no estado PENDING', () => {
        const props = transactionProps();
        const transaction = WagerTransaction.create(props);

        expect(transaction.id).toBe(props.id);
        expect(transaction.providerId).toBe(props.providerId);
        expect(transaction.externalTransactionId).toBe(
        props.externalTransactionId,
        );
        expect(transaction.idempotencyKey).toBe(props.idempotencyKey);
        expect(transaction.payloadHash).toBe(props.payloadHash);
        expect(transaction.kind).toBe(WagerTransactionKind.Bet);
        expect(transaction.money.equals(props.money)).toBe(true);
        expect(transaction.status).toBe(WagerTransactionStatus.Pending);
        expect(transaction.referenceExternalTransactionId).toBeUndefined();
    });

    test.each([
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback,
    ])('deve exigir referência para %s', (kind) => {
        expect(() =>
        WagerTransaction.create({
            ...transactionProps(),
            kind,
        }),
        ).toThrow(InvalidWagerTransactionError);
    });

    test.each([
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback,
    ])('deve aceitar %s com referência externa', (kind) => {
        const transaction = WagerTransaction.create({
        ...transactionProps(),
        kind,
        referenceExternalTransactionId: 'original-external-id',
        });

        expect(transaction.referenceExternalTransactionId).toBe(
        'original-external-id',
        );
        expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    });

    test('deve rejeitar referência fornecida em branco', () => {
        expect(() =>
        WagerTransaction.create({
            ...transactionProps(),
            referenceExternalTransactionId: '   ',
        }),
        ).toThrow(InvalidWagerTransactionError);
    });

    test('deve rejeitar valor monetário negativo', () => {
        const props = transactionProps();

        expect(() =>
        WagerTransaction.create({
            ...props,
            money: props.money.negate(),
        }),
        ).toThrow(InvalidWagerTransactionError);
    });

    test('deve proteger a data na entrada e na saída', () => {
        const props = transactionProps();
        const originalTime = props.createdAt.getTime();

        const transaction = WagerTransaction.create(props);

        props.createdAt.setTime(0);
        transaction.createdAt.setTime(0);

        expect(transaction.createdAt.getTime()).toBe(originalTime);
    });

    test('deve processar uma aposta e preservar a data', () => {
        const transaction = WagerTransaction.create(transactionProps());
        const at = new Date('2026-10-21T16:00:00.000Z');
        const originalTime = at.getTime();

        transaction.markProcessed(
            undefined,
            at,
            Money.from({
                amount: '75.00',
                currency: 'BRL',
            }),
        );

        at.setTime(0);
        transaction.processedAt?.setTime(0);

        expect(transaction.status).toBe(WagerTransactionStatus.Processed);
        expect(transaction.isTerminal()).toBe(true);
        expect(transaction.processedAt?.getTime()).toBe(originalTime);
        expect(transaction.failureCode).toBeUndefined();
    });

    test('deve aguardar a referência e depois processar um estorno', () => {
        const transaction = WagerTransaction.create({
            ...transactionProps(),
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: 'external-original',
        });

        transaction.markPendingReference();
        transaction.markPendingReference();

        expect(transaction.status).toBe(
            WagerTransactionStatus.PendingReference,
        );
        expect(transaction.isTerminal()).toBe(false);

        transaction.markProcessed(
            'internal-original',
            new Date(),
            Money.from({
                amount: '75.00',
                currency: 'BRL',
            }),
        );

        expect(transaction.status).toBe(WagerTransactionStatus.Processed);
        expect(transaction.referenceTransactionId).toBe(
            'internal-original',
        );
    });

    test('deve impedir processamento sem referência obrigatória', () => {
        const transaction = WagerTransaction.create({
            ...transactionProps(),
            kind: WagerTransactionKind.Rollback,
            referenceExternalTransactionId: 'external-original',
        });

        expect(() =>
            transaction.markProcessed(
                undefined,
                new Date(),
                Money.from({
                    amount: '75.00',
                    currency: 'BRL',
                }),
            ),
        ).toThrow(InvalidWagerTransactionError);

        expect(transaction.status).toBe(WagerTransactionStatus.Pending);
        expect(transaction.processedAt).toBeUndefined();
    });

    test('deve impedir que uma aposta aguarde referência', () => {
        const transaction = WagerTransaction.create(transactionProps());

        expect(() => transaction.markPendingReference()).toThrow(
            InvalidWagerTransactionError,
        );

        expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    });

    test('deve registrar o motivo de uma rejeição', () => {
        const transaction = WagerTransaction.create(transactionProps());

        transaction.reject(FailureCode.InsufficientBalance);

        expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
        expect(transaction.failureCode).toBe(
            FailureCode.InsufficientBalance,
        );
        expect(transaction.processedAt).toBeUndefined();
    });

    test.each([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    ])('deve bloquear novas transições após %s', (status) => {
        const transaction = WagerTransaction.create(transactionProps());

        if (status === WagerTransactionStatus.Processed) {
            transaction.markProcessed(
                undefined,
                new Date(),
                Money.from({
                    amount: '75.00',
                    currency: 'BRL',
                }),
            );
        } else if (status === WagerTransactionStatus.Rejected) {
            transaction.reject(FailureCode.InsufficientBalance);
        } else {
            transaction.fail(FailureCode.PermanentInfrastructureFailure);
        }

        expect(transaction.isTerminal()).toBe(true);

        expect(() =>
            transaction.markProcessed(
                undefined,
                new Date(),
                Money.from({
                amount: '75.00',
                currency: 'BRL',
                }),
            ),
        ).toThrow(InvalidTransactionStateError);

        expect(() => transaction.markPendingReference()).toThrow(
            InvalidTransactionStateError,
        );

        expect(() =>
            transaction.reject(FailureCode.InsufficientBalance),
        ).toThrow(InvalidTransactionStateError);

        expect(() =>
            transaction.fail(FailureCode.PermanentInfrastructureFailure),
        ).toThrow(InvalidTransactionStateError);

        expect(transaction.status).toBe(status);
    });

    test('deve reconstruir uma transação processada', () => {
        const processedAt = new Date('2026-10-21T16:00:00.000Z');

        const transaction = WagerTransaction.rehydrate({
            ...transactionProps(),
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: 'external-original',
            status: WagerTransactionStatus.Processed,
            referenceTransactionId: 'internal-original',
            processedAt,
            resultBalance: Money.from({
                amount: '75.00',
                currency: 'BRL',
            }),
        });

        expect(transaction.status).toBe(WagerTransactionStatus.Processed);
        expect(transaction.referenceExternalTransactionId).toBe(
            'external-original',
        );
        expect(transaction.referenceTransactionId).toBe(
            'internal-original',
        );
        expect(transaction.processedAt?.getTime()).toBe(
            processedAt.getTime(),
        );
        expect(transaction.isTerminal()).toBe(true);

        // O bloqueio de transições continua funcionando após a leitura.
        expect(() =>
            transaction.reject(FailureCode.InvalidReference),
        ).toThrow(InvalidTransactionStateError);
        expect(transaction.getProcessedResult().balance.amount).toBe('75.00',);
    });

    test.each([
        {
            status: WagerTransactionStatus.Rejected,
            code: FailureCode.InsufficientBalance,
        },
        {
            status: WagerTransactionStatus.Failed,
            code: FailureCode.PermanentInfrastructureFailure,
        },
        ])('deve restaurar o motivo do estado $status', ({ status, code }) => {
        const transaction = WagerTransaction.rehydrate({
            ...transactionProps(),
            status,
            failureCode: code,
        });

        expect(transaction.status).toBe(status);
        expect(transaction.failureCode).toBe(code);
        expect(transaction.processedAt).toBeUndefined();
        expect(transaction.isTerminal()).toBe(true);
    });

    test('deve reconstruir uma transação aguardando referência', () => {
        const transaction = WagerTransaction.rehydrate({
            ...transactionProps(),
            kind: WagerTransactionKind.Rollback,
            referenceExternalTransactionId: 'external-original',
            status: WagerTransactionStatus.PendingReference,
        });

        expect(transaction.isTerminal()).toBe(false);
        expect(transaction.processedAt).toBeUndefined();

        // Pode continuar o processamento quando a referência for resolvida.
        transaction.markProcessed(
            'internal-original',
            new Date(),
            Money.from({
                amount: '75.00',
                currency: 'BRL',
            }),
        );

        expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    });

    test('deve proteger as datas após a reidratação', () => {
        const props = transactionProps();
        const processedAt = new Date('2026-10-21T16:00:00.000Z');

        const originalCreatedAt = props.createdAt.getTime();
        const originalProcessedAt = processedAt.getTime();

        const transaction = WagerTransaction.rehydrate({
            ...props,
            status: WagerTransactionStatus.Processed,
            processedAt,
            resultBalance: Money.from({
                amount: '75.00',
                currency: 'BRL',
            }),
        });

        // Tenta modificar as datas fornecidas na entrada.
        props.createdAt.setTime(0);
        processedAt.setTime(0);

        // Tenta modificar as datas retornadas na saída.
        transaction.createdAt.setTime(0);
        transaction.processedAt?.setTime(0);

        expect(transaction.createdAt.getTime()).toBe(originalCreatedAt);
        expect(transaction.processedAt?.getTime()).toBe(
            originalProcessedAt,
        );
    });
});