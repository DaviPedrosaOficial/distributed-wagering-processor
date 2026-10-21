import { Money } from '../../shared/domain/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface OpenWalletProps {
    id: string;
    playerId: string;
    initialBalance: Money;
}

// CONTRATO DE RECONSTRUÇÃO (suporte ao rehydrate):
// Estado completo necessário para recuperar uma carteira existente.
// A camada de persistência fornecerá estes dados.
export interface WalletState {
    id: string,
    playerId: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
}

// Dados necessários para aplicar uma movimentação.
// Os identificadores são fornecidos pela camada de aplicação.
export interface WalletMovementProps {
    ledgerEntryId: string;
    transactionId: string;
    money: Money;
    at: Date;
}

export class InvalidWalletError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidWalletError';
    }
}

export class InsufficientBalanceError extends Error {
    constructor() {
        super('Saldo insuficiente para realizar o débito.',);
        this.name = 'InsufficientBalanceError';
    }
}

export class Wallet {
    private constructor(
        // ATRIBUTOS DE IDENTIDADE:
        public readonly id: string,
        public readonly playerId: string,
        
        //ATRIBUTO: moeda fixa da carteira.
        public readonly currency: string,

        // ATRIBUTOS DE ESTADO:
        // Permanecem privados para impedir alterações diretas.
        private _balance: Money,
        private _version: number,

        // ATRIBUTOS TEMPORAIS:
        // Date é mutável; não expomos estas referências diretamente.
        private readonly _createdAt: Date,
        private _updatedAt: Date,
    ) {}

    static open(props: OpenWalletProps): Wallet {
        const { id, playerId, initialBalance } = props;

        if (typeof id !== 'string' || id.trim() === '') {
            throw new InvalidWalletError('O indentificador da carteira é obrigatório.',);
        }

        if (typeof playerId !== 'string' || playerId.trim() === '') {
            throw new InvalidWalletError('O identificador do jogador é obrigatório.',);
        }

        if (initialBalance.isNegative()) {
            throw new InvalidWalletError('O saldo inicial não pode ser negativo.',);
        }

        const now = new Date();

        return new Wallet( id, playerId, initialBalance.currency, initialBalance, 1, now, new Date(now.getTime()), );
    }

    get balance(): Money {
        return this._balance;
    }

    get version(): number {
        return this._version;
    }

    get createdAt(): Date {
        return new Date(this._createdAt.getTime());
    }

    get updatedAt(): Date {
        return new Date(this._updatedAt.getTime());
    }

    // FACTORY DE REIDRATAÇÃO(rehydrate):
    // Reconstrói um estado previamente persistido.
    // Não executa novamente as regras de abertura ou movimentação.
    static rehydrate(state: WalletState): Wallet {
        return new Wallet(
            state.id,
            state.playerId,
            state.balance.currency,
            state.balance,
            state.version,
            new Date(state.createdAt.getTime()),
            new Date(state.updatedAt.getTime()),
        );
    }

    // MÉTODO DE MOVIMENTAÇÃO:
    // Aplica um débito e retorna seu lançamento financeiro.
    debit(props: WalletMovementProps): WalletLedgerEntry {
        return this.applyMovement(props, LedgerDirection.Debit);
    }

    // MÉTODO DE MOVIMENTAÇÃO:
    // Aplica um crédito e retorna seu lançamento financeiro.
    credit(props: WalletMovementProps): WalletLedgerEntry {
        return this.applyMovement(props, LedgerDirection.Credit);
    }

    // MÉTODO PRIVADO:
    // Centraliza as regras compartilhadas por crédito e débito.
    private applyMovement(props: WalletMovementProps, direction: LedgerDirection,): WalletLedgerEntry {
        if (!props.money.isPositive()) {
            throw new InvalidWalletError('O valor da movimentação deve ser positivo.',);
        }

        if(direction === LedgerDirection.Debit && this._balance.isLessThan(props.money)) {
            throw new InsufficientBalanceError();
        }

        const balanceAfter =
            direction === LedgerDirection.Debit
            ? this._balance.subtract(props.money)
            : this._balance.add(props.money);

        const entry = WalletLedgerEntry.create({
            id: props.ledgerEntryId,
            walletId: this.id,
            transactionId: props.transactionId,
            direction,
            money: props.money,
            balanceBefore: this._balance,
            balanceAfter,
            createdAt: props.at,
        });

        const updatedAt = entry.createdAt;

        this._balance = balanceAfter;
        this._version += 1;
        this._updatedAt = updatedAt;

        return entry;
    }
}