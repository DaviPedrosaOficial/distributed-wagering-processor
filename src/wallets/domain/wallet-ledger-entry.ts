import { Money } from '../../shared/domain/money.js';

export enum LedgerDirection {
    Debit = 'DEBIT',
    Credit = 'CREDIT',
}

export interface LedgerEntryState {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
}

export class InvalidLedgerEntryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidLedgerEntryError';
    }
}

export class WalletLedgerEntry {
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly direction: LedgerDirection,
        public readonly money: Money,
        public readonly balanceBefore: Money,
        public readonly balanceAfter: Money,
        private readonly _createdAt: Date,
    ) {
        Object.freeze(this);
    }

    static create(props: LedgerEntryState): WalletLedgerEntry {
        const identifiers = [
            props.id,
            props.walletId,
            props.transactionId,
        ];

        if (identifiers.some((id) => typeof id !== 'string' || id.trim() === '',)) {
            throw new InvalidLedgerEntryError('Os identificadores do lançamento são obrigatórios.',);
        }

        if (props.direction !== LedgerDirection.Debit &&
            props.direction !== LedgerDirection.Credit
        ) {
            throw new InvalidLedgerEntryError('Direção de lançamento inválida.',);
        }

        if (!props.money.isPositive()) {
            throw new InvalidLedgerEntryError('O valor do lançamento deve ser positivo.',);
        }

        if (props.balanceBefore.isNegative() ||
            props.balanceAfter.isNegative()
        ) {
            throw new InvalidLedgerEntryError('Os saldos do lançamento não podem ser negativos.',);
        }

        if (!Number.isFinite(props.createdAt.getTime())) {
            throw new InvalidLedgerEntryError('A data do lançamento deve ser válida.',);
        }

        const entry = WalletLedgerEntry.rehydrate(props);

        if (!entry.isBalanced()) {
            throw new InvalidLedgerEntryError('O lançamento não corresponde à alteração de saldo.',);
        }

        return entry;
    }

    static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
        return new WalletLedgerEntry(
            state.id,
            state.walletId,
            state.transactionId,
            state.direction,
            state.money,
            state.balanceBefore,
            state.balanceAfter,
            new Date(state.createdAt.getTime()),
        );
    }

    isBalanced(): boolean {
        const expectedBalance =
            this.direction === LedgerDirection.Debit
            ? this.balanceBefore.subtract(this.money)
            : this.balanceBefore.add(this.money);

            return expectedBalance.equals(this.balanceAfter);
    }

    get createdAt(): Date {
        return new Date(this._createdAt.getTime());
    }
}