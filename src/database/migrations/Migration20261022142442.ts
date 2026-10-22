import { Migration } from "@mikro-orm/migrations";

export class Migration20261022142442 extends Migration {
  override name = "Migration20261022142442";

  override up(): void | Promise<void> {
    this.addSql(
      `create table "outbox_messages" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" varchar(255) not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`,
    );
    this.addSql(
      `create index "outbox_pending_index" on "outbox_messages" ("published_at", "next_attempt_at", "occurred_at", "id");`,
    );

    // A migration anterior já criou wallets. Preserva seu histórico e seus dados.
    this.addSql(
      `alter table "wallets" alter column "id" type uuid using "id"::uuid;`,
    );

    this.addSql(
      `create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(255) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" text not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "status" text not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "failure_code" text null, "result_balance" numeric(20,2) null, "created_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`,
    );
    this.addSql(
      `create index "wager_transactions_wallet_created_index" on "wager_transactions" ("wallet_id", "created_at", "id");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_idempotency_unique" unique ("idempotency_key");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id");`,
    );

    this.addSql(
      `create table "wallet_ledger" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "created_at" timestamptz not null, primary key ("id"));`,
    );
    this.addSql(
      `create index "wallet_ledger_wallet_created_index" on "wallet_ledger" ("wallet_id", "created_at", "id");`,
    );
    this.addSql(
      `alter table "wallet_ledger" add constraint "wallet_ledger_transaction_wallet_unique" unique ("transaction_id", "wallet_id");`,
    );

    this.addSql(
      `alter table "outbox_messages" add constraint "outbox_attempts_nonnegative" check (attempts >= 0);`,
    );

    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_amount_range" check (amount >= 0 AND amount <= 999999999999999999.99);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_currency_supported" check (currency IN ('BRL', 'USD'));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_result_balance_range" check (result_balance IS NULL OR (result_balance >= 0 AND result_balance <= 999999999999999999.99));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_processed_result" check (status <> 'PROCESSED' OR (processed_at IS NOT NULL AND result_balance IS NOT NULL));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_failure_required" check (status NOT IN ('REJECTED', 'FAILED') OR failure_code IS NOT NULL);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_required" check (kind NOT IN ('REFUND', 'ROLLBACK') OR (reference_external_transaction_id IS NOT NULL AND btrim(reference_external_transaction_id) <> ''));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_failure_code_check" check ("failure_code" in ('INSUFFICIENT_BALANCE', 'CURRENCY_MISMATCH', 'REFERENCE_NOT_FOUND', 'INVALID_REFERENCE', 'REVERSAL_INSUFFICIENT_BALANCE', 'PERMANENT_INFRASTRUCTURE_FAILURE'));`,
    );

    this.addSql(
      `alter table "wallet_ledger" add constraint "wallet_ledger_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`,
    );
    this.addSql(
      `alter table "wallet_ledger" add constraint "wallet_ledger_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict;`,
    );
    this.addSql(
      `alter table "wallet_ledger" add constraint "wallet_ledger_amount_positive" check (amount > 0 AND amount <= 999999999999999999.99);`,
    );
    this.addSql(
      `alter table "wallet_ledger" add constraint "wallet_ledger_currency_supported" check (currency IN ('BRL', 'USD'));`,
    );
    this.addSql(
      `alter table "wallet_ledger" add constraint "wallet_ledger_balances_range" check (balance_before >= 0 AND balance_before <= 999999999999999999.99 AND balance_after >= 0 AND balance_after <= 999999999999999999.99);`,
    );
    this.addSql(
      `alter table "wallet_ledger" add constraint "wallet_ledger_balanced" check ((direction = 'DEBIT' AND balance_after = balance_before - amount) OR (direction = 'CREDIT' AND balance_after = balance_before + amount));`,
    );
    this.addSql(
      `alter table "wallet_ledger" add constraint "wallet_ledger_direction_check" check ("direction" in ('DEBIT', 'CREDIT'));`,
    );

    // Imutabilidade aplicada pelo banco, inclusive para SQL fora do ORM.
    this
      .addSql(`create function prevent_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'Lançamentos do ledger são imutáveis' using errcode = '23514';
      end;
    $$;`);
    this
      .addSql(`create trigger wallet_ledger_immutable before update or delete on wallet_ledger
      for each row execute function prevent_ledger_mutation();`);
    this
      .addSql(`create trigger wallet_ledger_no_truncate before truncate on wallet_ledger
      for each statement execute function prevent_ledger_mutation();`);

    // Um lançamento precisa corresponder à operação financeira processada.
    this
      .addSql(`create function validate_ledger_transaction() returns trigger language plpgsql as $$
      begin
        if not exists (
          select 1 from wager_transactions t join wallets w on w.id = t.wallet_id
          where t.id = new.transaction_id and t.wallet_id = new.wallet_id
            and t.currency = new.currency and w.currency = new.currency
            and t.player_id = w.player_id and t.amount = new.amount
            and t.status = 'PROCESSED' and t.kind <> 'LOSS'
            and t.result_balance = new.balance_after
        ) then
          raise exception 'Ledger incompatível com a transação' using errcode = '23514';
        end if;
        return new;
      end;
    $$;`);
    this
      .addSql(`create trigger wallet_ledger_validate before insert on wallet_ledger
      for each row execute function validate_ledger_transaction();`);

    this
      .addSql(`create function prevent_terminal_transaction_mutation() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'Transação finalizada não pode ser alterada ou excluída' using errcode = '23514';
        end if;
        if tg_op = 'DELETE' then return old; end if;
        return new;
      end;
    $$;`);
    this
      .addSql(`create trigger wager_transactions_terminal before update or delete on wager_transactions
      for each row execute function prevent_terminal_transaction_mutation();`);
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_wallet_id_foreign";`,
    );
    this.addSql(
      `alter table "wallet_ledger" drop constraint "wallet_ledger_wallet_id_foreign";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`,
    );
    this.addSql(
      `alter table "wallet_ledger" drop constraint "wallet_ledger_transaction_id_foreign";`,
    );

    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallet_ledger" cascade;`);
    this.addSql(`drop function if exists prevent_ledger_mutation();`);
    this.addSql(`drop function if exists validate_ledger_transaction();`);
    this.addSql(
      `drop function if exists prevent_terminal_transaction_mutation();`,
    );
    this.addSql(
      `alter table "wallets" alter column "id" type varchar(255) using "id"::text;`,
    );
  }
}
