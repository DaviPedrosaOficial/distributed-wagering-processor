import { Migration } from '@mikro-orm/migrations';

export class Migration20261021232002 extends Migration {

  override name = 'Migration20261021232002';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallets" ("id" varchar(255) not null, "player_id" uuid not null, "currency" varchar(3) not null, "balance" numeric(20,2) not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`alter table "wallets" add constraint "wallets_balance_range" check (balance >= 0 AND balance <= 999999999999999999.99);`);
    this.addSql(`alter table "wallets" add constraint "wallets_version_positive" check (version >= 1);`);
    this.addSql(`alter table "wallets" add constraint "wallets_currency_supported" check (currency IN ('BRL', 'USD'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallets" cascade;`);
  }

}
