import { Migration } from "@mikro-orm/migrations";
export class Migration20261022203000 extends Migration {
  override name = "Migration20261022203000";
  override up(): void {
    this.addSql(
      `create table reference_schedules (transaction_id uuid primary key references wager_transactions(id) on delete restrict, attempts integer not null, next_attempt_at timestamptz not null, expires_at timestamptz not null, correlation_id varchar(128) not null, constraint reference_schedules_attempts_nonnegative check (attempts >= 0));`,
    );
    this.addSql(
      `create index reference_schedules_due_index on reference_schedules (next_attempt_at, transaction_id);`,
    );
    this.addSql(
      `create unique index wager_transactions_reversal_unique on wager_transactions (reference_transaction_id, kind) where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');`,
    );
    this.addSql(
      `alter table wager_transactions add constraint wager_transactions_resolved_reversal check (status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK') or reference_transaction_id is not null);`,
    );
    this
      .addSql(`create function validate_processed_reference() returns trigger language plpgsql as $$
      begin
        if new.status = 'PROCESSED' and new.reference_external_transaction_id is not null then
          if not exists (
            select 1 from wager_transactions r where r.id = new.reference_transaction_id
              and r.id <> new.id and r.status = 'PROCESSED'
              and r.provider_id = new.provider_id and r.external_transaction_id = new.reference_external_transaction_id
              and r.wallet_id = new.wallet_id and r.player_id = new.player_id
              and r.currency = new.currency and r.round_id = new.round_id
              and ((new.kind = 'WIN' and r.kind = 'BET')
                or (new.kind = 'REFUND' and r.kind = 'BET' and r.amount = new.amount)
                or (new.kind = 'ROLLBACK' and r.kind in ('BET','WIN','REFUND') and r.amount = new.amount))
          ) then raise exception 'Referência incompatível' using errcode = '23514'; end if;
        end if;
        return new;
      end;
    $$;`);
    this.addSql(
      `create trigger wager_transactions_validate_reference before insert or update on wager_transactions for each row execute function validate_processed_reference();`,
    );
  }
  override down(): void {
    this.addSql(
      `drop trigger wager_transactions_validate_reference on wager_transactions;`,
    );
    this.addSql(`drop function validate_processed_reference();`);
    this.addSql(
      `alter table wager_transactions drop constraint wager_transactions_resolved_reversal;`,
    );
    this.addSql(`drop index wager_transactions_reversal_unique;`);
    this.addSql(`drop table reference_schedules;`);
  }
}
