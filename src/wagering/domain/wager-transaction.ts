import { Money } from '../../shared/domain/money.js';

export enum WagerTransactionKind {
    Opening = 'OPENING',
    Bet = 'BET',
    Win = 'WIN',
    Loss = 'Loss',
    Refund = 'REFUND',
    Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
    Pending = 'PENDING',
    PendingReference = 'PENDING_REFERENCE',
    Processed = 'PROCESSED',
    Rejected = 'REJECTED',
    Failed = 'FAILED',
}

export enum FailureCode {
    InsufficientBalance = 'INSUFFICIENT_BALANCE',
    CurrencyMismatch = 'CURRENCY_MISMATCH',
    ReferenceNotFound = 'REFERENCE_NOT_FOUND',
    InvalidReference = 'INVALID_REFERENCE',
    ReversalInsufficientBalance = 'REVERSAL_INSUFFICIENT_BALANCE',
    PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

// ESTADO PERSISTIDO:
// Inclui os dados de criação e o resultado do processamento.
export interface WagerTransactionState extends CreateWagerTransactionProps {
    status: WagerTransactionStatus;
    referenceTransactionId?: string;
    failureCode?: FailureCode;
    processedAt?: Date;
}

export class InvalidTransactionStateError extends Error {
    constructor(status: WagerTransactionStatus) {
        super(`A transação no estado ${status} não permite esta transição`);
        this.name = 'InvalidTransactionStateError';
    }
}

export interface CreateWagerTransactionProps {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId?: string;
    createdAt: Date;
}

export class InvalidWagerTransactionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidWagerTransactionError';
    }
}

export class WagerTransaction {
    private _status = WagerTransactionStatus.Pending;
    private _referenceTransactionId: string | undefined;
    private _failureCode: FailureCode | undefined;
    private _processedAt: Date | undefined;

    private constructor(
        // IDENTIDADE INTERNA:
        public readonly id: string,

        // IDENTIDADE DA OPERAÇÃO NO PROVEDOR:
        public readonly providerId: string,
        public readonly externalTransactionId: string,

        // DADOS PARA IDEMPOTÊNCIA:
        public readonly idempotencyKey: string,
        public readonly payloadHash: string,

        // CONTEXTO DA OPERAÇÃO:
        public readonly walletId: string,
        public readonly playerId: string,
        public readonly roundId: string,
        public readonly gameId: string,

        // CONTEÚDO FINANCEIRO:
        public readonly kind: WagerTransactionKind,
        public readonly money: Money,

        // REFERÊNCIA EXTERNA:
        // Ainda não é o identificador interno da transação referenciada.
        public readonly referenceExternalTransactionId:
        | string
        | undefined,

        private readonly _createdAt: Date,
    ) {}

    static create(props: CreateWagerTransactionProps,): WagerTransaction {
        const identifiers = [
            props.id,
            props.providerId,
            props.externalTransactionId,
            props.idempotencyKey,
            props.payloadHash,
            props.walletId,
            props.playerId,
            props.roundId,
            props.gameId,
        ];

        if (identifiers.some((value) => typeof value !== 'string' || value.trim() === '')) {
            throw new InvalidWagerTransactionError('Os identificadores e o hash da transação são obrigatórios.',);
        }

        if (!Object.values(WagerTransactionKind).includes(props.kind)) {
            throw new InvalidWagerTransactionError('Tipo de transação inválido.',);
        }

        if (props.money.isNegative()) {
            throw new InvalidWagerTransactionError('O valor da transação não pode ser negativo.',);
        }

        if (
            props.referenceExternalTransactionId !== undefined &&
            (
                typeof props.externalTransactionId !== 'string' ||
                props.referenceExternalTransactionId.trim() === ''
            )
        ) {
            throw new InvalidWagerTransactionError('A referência externa deve ser um identificador válido.',);
        }

        const requiresReference =
        props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback;

        if (requiresReference && props.referenceExternalTransactionId === undefined) {
            throw new InvalidWagerTransactionError('REFUND e ROLLBACK exigem referência externa.',);
        }

        if (!Number.isFinite(props.createdAt.getTime())) {
            throw new InvalidWagerTransactionError('A data da transação deve ser válida.',);
        }

        return new WagerTransaction(
            props.id,
            props.providerId,
            props.externalTransactionId,
            props.idempotencyKey,
            props.payloadHash,
            props.walletId,
            props.playerId,
            props.roundId,
            props.gameId,
            props.kind,
            props.money,
            props.referenceExternalTransactionId,
            new Date(props.createdAt.getTime()),
        );
    }

    // FACTORY DE REIDRATAÇÃO:
    // Reconstrói um estado confiável vindo da persistência.
    // Não executa novamente as regras de criação ou transição.
    static rehydrate(state: WagerTransactionState): WagerTransaction {
        const transaction = new WagerTransaction(
            state.id,
            state.providerId,
            state.externalTransactionId,
            state.idempotencyKey,
            state.payloadHash,
            state.walletId,
            state.playerId,
            state.roundId,
            state.gameId,
            state.kind,
            state.money,
            state.referenceExternalTransactionId,
            new Date(state.createdAt.getTime()),
        );

        // Restaura o estado existente, sem executar transições.
        transaction._status = state.status;
        transaction._referenceTransactionId = state.referenceTransactionId;
        transaction._failureCode = state.failureCode;

        // Copia a data quando houver.
        transaction._processedAt = 
            state.processedAt === undefined
                ? undefined
                : new Date(state.processedAt.getTime());

        return transaction;
    }

    // CONSULTA: informa se o processamento já terminou.
    isTerminal(): boolean {
        return (
            this._status === WagerTransactionStatus.Processed ||
            this._status === WagerTransactionStatus.Rejected ||
            this._status === WagerTransactionStatus.Failed
        );
    }

    // CONSULTA: identifica os tipos que exigem referência.
    requiresReference(): boolean {
        return (
            this.kind === WagerTransactionKind.Refund ||
            this.kind === WagerTransactionKind.Rollback
        );
    }

    // TRANSIÇÃO: registra que a referência ainda não foi encontrada.
    markPendingReference(): void {
        this.assertNotTerminal();

        if (!this.requiresReference()) {
            throw new InvalidWagerTransactionError('Este tipo de transação não exige aguardar uma referência.',);
        }

        this._status = WagerTransactionStatus.PendingReference;
    }

    // TRANSIÇÃO: confirma o processamento.
    // Recebe o identificador interno da referência, quando existir.
    markProcessed(referenceTransactionId: string | undefined, at: Date): void {
        this.assertNotTerminal();

        if (
            referenceTransactionId !== undefined &&
            (
                typeof referenceTransactionId !== 'string' ||
                referenceTransactionId.trim() === ''
            )
        ) {
            throw new InvalidWagerTransactionError('O identificador interno da referência deve ser válido.',);
        }

        if (this.requiresReference() && referenceTransactionId === undefined) {
            throw new InvalidWagerTransactionError('A transação exige uma referência interna resolvida.',);
        }

        if (!Number.isFinite(at.getTime())) {
            throw new InvalidWagerTransactionError('A data de processamento deve ser válida.',);
        }

        // Copia e valida antes de modificar o estado.
        const processedAt = new Date(at.getTime());

        this._referenceTransactionId = referenceTransactionId;
        this._processedAt = processedAt;
        this._status = WagerTransactionStatus.Processed;
    }

    // TRANSIÇÃO: encerra por rejeição de negócio.
    reject(code: FailureCode) : void {
        this.assertNotTerminal();
        this.assertValidFailureCode(code);

        this._failureCode = code;
        this._status = WagerTransactionStatus.Rejected;
    }

    // TRANSIÇÃO: encerra por falha permanente de infraestrutura.
    fail(code: FailureCode): void {
        this.assertNotTerminal();
        this.assertValidFailureCode(code);

        this._failureCode = code;
        this._status = WagerTransactionStatus.Failed;
    }

    // PROTEÇÃO: impede qualquer transição após a finalização.
    private assertNotTerminal(): void {
        if (this.isTerminal()) {
            throw new InvalidTransactionStateError(this.status);
        }
    }

    private assertValidFailureCode(code: FailureCode): void {
        if (!Object.values(FailureCode).includes(code)) {
            throw new InvalidWagerTransactionError('Código de falha inválido.',);
        }
    }

    get status(): WagerTransactionStatus {
        return this._status;
    }

    get createdAt(): Date {
        return new Date(this._createdAt.getTime());
    }

    get referenceTransactionId(): string | undefined {
        return this._referenceTransactionId;
    }

    get failureCode(): FailureCode | undefined {
        return this._failureCode;
    }

    get processedAt(): Date | undefined {
        return this._processedAt === undefined
        ? undefined
        : new Date(this._processedAt.getTime());
    }
}