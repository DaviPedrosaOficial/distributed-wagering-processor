import { Migration } from "@mikro-orm/migrations";
export class Migration20261022220000 extends Migration {
  override name = "Migration20261022220000";
  override up(): void {
    this.addSql(
      `create table inbox_messages (message_id varchar(128) not null, consumer_name varchar(128) not null, payload_hash varchar(64) not null, received_at timestamptz not null, processed_at timestamptz null, result jsonb null, primary key (message_id,consumer_name), constraint inbox_messages_processed_result check (processed_at is null or result is not null));`,
    );
    this.addSql(
      `create function prevent_inbox_mutation() returns trigger language plpgsql as $$ begin if old.processed_at is not null then raise exception 'Inbox confirmada é imutável' using errcode = '23514'; end if; if tg_op = 'DELETE' then return old; end if; return new; end; $$;`,
    );
    this.addSql(
      `create trigger inbox_messages_immutable before update or delete on inbox_messages for each row execute function prevent_inbox_mutation();`,
    );
  }
  override down(): void {
    this.addSql(`drop table inbox_messages;`);
    this.addSql(`drop function prevent_inbox_mutation();`);
  }
}
