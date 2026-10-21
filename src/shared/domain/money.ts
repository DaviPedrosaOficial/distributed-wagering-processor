 /* No desafio foi exigido que o dinheiro fosse representado com precisão decimal, entrada e saída como string e operações imutáveis.
  Além de solicitar que o domínio seja independente de NestJS e do ORM.
  Sendo assim, estou criando a classe para atender aos requisitos. */

import { Decimal } from 'decimal.js';

// Moedas aceitas pelo domínio nesta implementação.
// O Set permite consultar se um código pertence ao conjunto.
const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set([
    'BRL',
    'USD'
]);

// Configuração exclusiva dos cálculos monetários.
// Não altera a configuração global da biblioteca.
const MoneyDecimal = Decimal.clone({
  precision: 40,
});

// Limite escolhido para futura persistência em NUMERIC(20, 2):
// 18 dígitos inteiros e 2 casas decimais.
const MAX_MONEY_AMOUNT = new MoneyDecimal(
  '999999999999999999.99',
);

export interface MoneyProps {
    amount: string;
    currency: string;
}

export class InvalidMoneyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidMoneyError';
    }
}

export class CurrencyMismatchError extends Error {
    constructor() {
        super('Não é permitido operar valores de moedas diferentes.');
        this.name = 'CurrencyMismatchError';
    }
}

export class Money {
    private constructor(
        private readonly value: Decimal,
        public readonly currency: string,
    ) {
        if (value.abs().greaterThan(MAX_MONEY_AMOUNT)) {
            throw new InvalidMoneyError('O valor monetário excede o limite permitido.',);
        }

        Object.freeze(this);
    }

    static from(props: MoneyProps): Money {
        const { amount, currency } = props;

        
        if (typeof amount !== 'string' || !/^\d+\.\d{2}$/.test(amount)) {
            throw new InvalidMoneyError('O valor deve ser uma string não negativa com exatamente duas casas decimais.',);
        }
        
        if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
            throw new InvalidMoneyError('A moeda deve conter três letras maiúsculas.',);
        }

        if (!SUPPORTED_CURRENCIES.has(currency)) {
            throw new InvalidMoneyError(
                `Moeda não suportada: ${currency}.`,
            );
        }

        return new Money(new MoneyDecimal(amount), currency);
    }

    static zero(currency: string): Money {
        return Money.from({ amount: '0.00', currency, });
    }

    add(other: Money) : Money {
        this.assertSameCurrency(other);

        return new Money(
            this.value.plus(other.value),
            this.currency,
        );
    }

    subtract(other: Money) : Money {
        this.assertSameCurrency(other);

        return new Money(
            this.value.minus(other.value),
            this.currency,
        );
    }

    negate(): Money {
        return new Money (
            this.value.negated(),
            this.currency,
        );
    }

    isZero(): boolean {
        return this.value.isZero();
    }

    isPositive(): boolean {
        return this.value.greaterThan('0');
    }

    isNegative(): boolean {
        return this.value.lessThan('0');
    }

    isLessThan(other: Money) : boolean {
        this.assertSameCurrency(other);

        return this.value.lessThan(other.value);
    }

    equals(other: Money) : boolean {
        this.assertSameCurrency(other);

        return this.value.equals(other.value);
    }

    private assertSameCurrency (other: Money) : void {
        if (this.currency !== other.currency) {
            throw new CurrencyMismatchError();
        }
    }

    toJSON(): MoneyProps {
        return {
            amount: this.value.toFixed(2),
            currency: this.currency,
        };
    }

    toString(): string {
        return `${this.value.toFixed(2)} ${this.currency}`;
    }
}