import { DecimalType, EntitySchema } from '@mikro-orm/core';

// REGISTRO DE PERSISTÊNCIA:
// Representa uma linha da tabela wallets.
export class WalletRecord {
    id!: string;
    playerId!: string;
    currency!: string;

    balance!: string;

    version!: number;
    createdAt!: Date;
    updatedAt!: Date;
}

// MAPEAMENTO:
// Descreve como cada propriedade será armazenada no banco.
export const WalletRecordSchema = new EntitySchema<WalletRecord>({
    class: WalletRecord,
    tableName: 'wallets',

    properties: {
        id: {
            type: 'string',
            primary: true,
        },

        playerId: {
            type: 'uuid',
            fieldName: 'player_id'
        },

        currency: {
            type: 'string',
            length: 3,
        },

        balance: {
            type: new DecimalType('string'),
            precision: 20,
            scale: 2,
        },

        version: {
            type: 'integer',
        },

        createdAt: {
            type: Date,
            columnType: 'timestamptz',
            fieldName: 'created_at',
        },

        updatedAt: {
            type: Date,
            columnType: 'timestamptz',
            fieldName: 'updated_at',
        },
    },

    // Uma carteira por jogador e moeda, garantida pelo PostgreSQL.
    uniques: [
        {
            name: 'wallets_player_currency_unique',
            properties: ['playerId', 'currency'],
        },
    ],

    // Regras aplicadas pelo banco, mesmo fora da aplicação.
    checks: [
        {
            name: 'wallets_balance_range',
            expression: 'balance >= 0 AND balance <= 999999999999999999.99',
        },
        {
            name: 'wallets_version_positive',
            expression: 'version >= 1',
        },
        {
            name: 'wallets_currency_supported',
            expression: "currency IN ('BRL', 'USD')",
        },
    ],
});