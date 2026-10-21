import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money, } from './money.js';

describe('Money', () => {
  test('deve criar um valor monetário válido', () => {
    const money = Money.from({
      amount: '25.00',
      currency: 'BRL',
    });

    expect(money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  test('deve preservar os centavos na serialização', () => {
    const money = Money.from({
      amount: '0.10',
      currency: 'BRL',
    });

    expect(money.toJSON().amount).toBe('0.10');
  });

  test('deve criar um valor zero na moeda informada', () => {
    const money = Money.zero('BRL');

    expect(money.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
  });

  test('deve produzir uma representação textual', () => {
    const money = Money.from({
      amount: '25.00',
      currency: 'BRL',
    });

    expect(money.toString()).toBe('25.00 BRL');
  });

  test('deve serializar usando strings no JSON', () => {
    const money = Money.from({
      amount: '25.00',
      currency: 'BRL',
    });

    expect(JSON.stringify(money)).toBe(
      '{"amount":"25.00","currency":"BRL"}',
    );
  });

    test.each([
        '',
        '25',
        '25.0',
        '25.001',
        '-25.00',
        '25,00',
        '1e2',
        'NaN',
        'Infinity',
        ' 25.00',
        '25.00 ',
    ])('deve rejeitar o valor inválido "%s"', (amount) => {
        expect(() =>
        Money.from({
            amount,
            currency: 'BRL',
        }),
        ).toThrow(InvalidMoneyError);
    });

    test.each([
        '',
        'brl',
        'BrL',
        'BR',
        'BRLL',
        '123',
        ' BRL',
    ])('deve rejeitar o formato de moeda "%s"', (currency) => {
        expect(() =>
        Money.from({
            amount: '25.00',
            currency,
        }),
        ).toThrow(InvalidMoneyError);
    });

    test('deve validar a moeda ao criar um valor zero', () => {
        expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
    });

    test('deve permitir uma segunda moeda suportada', () => {
        const money = Money.from({
            amount: '25.00',
            currency: 'USD',
        });

        expect(money.toJSON()).toEqual({
            amount: '25.00',
            currency: 'USD',
            });
        });

    test.each(['ZZZ', 'EUR'])('deve rejeitar a moeda não suportada "%s"', (currency) => {
        expect(() =>
        Money.from({
            amount: '25.00',
            currency,
        }),
        ).toThrow(InvalidMoneyError);
    },
    );

    test('deve rejeitar moeda não suportada na criação de zero', () => {
        expect(() => Money.zero('ZZZ')).toThrow(InvalidMoneyError);
    });

    test('deve somar centavos com precisão', () => {
        const first = Money.from({
            amount: '0.10',
            currency: 'BRL',
        });

        const second = Money.from({
            amount: '0.20',
            currency: 'BRL',
        });

        expect(first.add(second).toJSON().amount).toBe('0.30');
    });

    test('deve preservar os operandos e retornar outra instância', () => {
        const first = Money.from({
            amount: '10.00',
            currency: 'BRL',
        });

        const second = Money.from({
            amount: '5.00',
            currency: 'BRL',
        });

        const result = first.add(second);

        expect(result.toJSON().amount).toBe('15.00');
        expect(result).not.toBe(first);
        expect(result).not.toBe(second);
        expect(first.toJSON().amount).toBe('10.00');
        expect(second.toJSON().amount).toBe('5.00');
    });

    test('deve subtrair sem alterar os operandos', () => {
        const first = Money.from({
            amount: '10.00',
            currency: 'BRL',
        });

        const second = Money.from({
            amount: '3.25',
            currency: 'BRL',
        });

        expect(first.subtract(second).toJSON().amount).toBe('6.75');
        expect(first.toJSON().amount).toBe('10.00');
        expect(second.toJSON().amount).toBe('3.25');
    });

    test('deve permitir resultado interno negativo', () => {
        const first = Money.from({
            amount: '5.00',
            currency: 'BRL',
        });

        const second = Money.from({
            amount: '10.00',
            currency: 'BRL',
        });

        expect(first.subtract(second).toJSON().amount).toBe('-5.00');
    });

    test('deve rejeitar soma e subtração entre moedas diferentes', () => {
        const brl = Money.from({
            amount: '10.00',
            currency: 'BRL',
        });

        const usd = Money.from({
            amount: '10.00',
            currency: 'USD',
        });

        expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
        expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    });

    test('deve preservar centavos perto do limite monetário', () => {
        const value = Money.from({
            amount: '999999999999999999.98',
            currency: 'BRL',
        });

        const cent = Money.from({
            amount: '0.01',
            currency: 'BRL',
        });

        expect(value.add(cent).toJSON().amount).toBe(
            '999999999999999999.99',
        );
    });

    test('deve rejeitar uma entrada acima do limite monetário', () => {
        expect(() =>
            Money.from({
            amount: '1000000000000000000.00',
            currency: 'BRL',
            }),
        ).toThrow(InvalidMoneyError);
    });

    test('deve rejeitar uma soma que ultrapasse o limite', () => {
        const maximum = Money.from({
            amount: '999999999999999999.99',
            currency: 'BRL',
        });

        const cent = Money.from({
            amount: '0.01',
            currency: 'BRL',
        });

        expect(() => maximum.add(cent)).toThrow(InvalidMoneyError);
    });

    test('deve inverter o sinal sem alterar o original', () => {
        const original = Money.from({
            amount: '25.00',
            currency: 'BRL',
        });

        const negative = original.negate();

        expect(negative.toJSON().amount).toBe('-25.00');
        expect(negative.currency).toBe('BRL');
        expect(negative).not.toBe(original);
        expect(original.toJSON().amount).toBe('25.00');
    });

    test('deve recuperar o valor ao inverter o sinal duas vezes', () => {
        const original = Money.from({
            amount: '25.00',
            currency: 'BRL',
        });

        expect(original.negate().negate().equals(original)).toBe(true);
    });

    test('deve identificar zero sem classificá-lo como positivo ou negativo', () => {
        const zero = Money.zero('BRL');

        expect(zero.isZero()).toBe(true);
        expect(zero.isPositive()).toBe(false);
        expect(zero.isNegative()).toBe(false);

        const negatedZero = zero.negate();

        expect(negatedZero.isZero()).toBe(true);
        expect(negatedZero.isPositive()).toBe(false);
        expect(negatedZero.isNegative()).toBe(false);
        expect(negatedZero.toJSON().amount).toBe('0.00');
    });

    test('deve identificar um valor positivo', () => {
        const money = Money.from({
            amount: '0.01',
            currency: 'BRL',
        });

        expect(money.isPositive()).toBe(true);
        expect(money.isNegative()).toBe(false);
        expect(money.isZero()).toBe(false);
    });

    test('deve identificar um valor negativo', () => {
        const money = Money.from({
            amount: '0.01',
            currency: 'BRL',
        }).negate();

        expect(money.isNegative()).toBe(true);
        expect(money.isPositive()).toBe(false);
        expect(money.isZero()).toBe(false);
    });

    test('deve comparar valores da mesma moeda', () => {
        const smaller = Money.from({
            amount: '10.00',
            currency: 'BRL',
        });

        const larger = Money.from({
            amount: '20.00',
            currency: 'BRL',
        });

        expect(smaller.isLessThan(larger)).toBe(true);
        expect(larger.isLessThan(smaller)).toBe(false);
        expect(smaller.isLessThan(smaller)).toBe(false);
        expect(smaller.negate().isLessThan(smaller)).toBe(true);
    });

    test('deve comparar igualdade pelo conteúdo monetário', () => {
        const first = Money.from({
            amount: '25.00',
            currency: 'BRL',
        });

        const sameValue = Money.from({
            amount: '25.00',
            currency: 'BRL',
        });

        const differentValue = Money.from({
            amount: '25.01',
            currency: 'BRL',
        });

        expect(first).not.toBe(sameValue);
        expect(first.equals(sameValue)).toBe(true);
        expect(first.equals(differentValue)).toBe(false);
    });

    test('deve rejeitar comparações entre moedas diferentes', () => {
        const brl = Money.from({
            amount: '25.00',
            currency: 'BRL',
        });

        const usd = Money.from({
            amount: '25.00',
            currency: 'USD',
        });

        expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
        expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
    });
});