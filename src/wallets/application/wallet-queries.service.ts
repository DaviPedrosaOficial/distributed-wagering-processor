import { BadRequestException, Injectable, NotFoundException, } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { Decimal } from "decimal.js";
import { WalletRecord } from "../../database/entities/wallet.record.js";
import { WalletLedgerRecord } from "../../database/entities/wallet-ledger.record.js";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor.js";
import { telemetry, operationalLog } from "../../operations/telemetry.js";

const ExactDecimal = Decimal.clone({ precision: 80 });
@Injectable()
export class WalletQueriesService {
  constructor(private readonly orm: MikroORM) {}
  
  async ledger(walletId: string, query: { cursor?: string; limit?: string }) {
    const em = this.orm.em.fork();
    const wallet = await em.findOne(WalletRecord, { id: walletId });
    if (!wallet) throw new NotFoundException({ code: "WALLET_NOT_FOUND" });
    const limit = Number(query.limit ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException({ code: "INVALID_LEDGER_LIMIT" });
    let after = "";
    if (query.cursor) {
      after = decodeLedgerCursor(query.cursor, wallet.id);
      if (
        !(await em.findOne(WalletLedgerRecord, {
          id: after,
          walletId: wallet.id,
        }))
      )
        throw new BadRequestException({ code: "INVALID_LEDGER_CURSOR" });
    }
    const rows = await em.getConnection().execute<
      Array<{
        id: string;
        transaction_id: string;
        direction: string;
        amount: string;
        currency: string;
        balance_before: string;
        balance_after: string;
        created_at: Date;
      }>
    >(`select id,transaction_id,direction,amount::text,currency,balance_before::text,balance_after::text,created_at from wallet_ledger where wallet_id=?::uuid ${after ? "and (created_at,id) > (select created_at,id from wallet_ledger where id=?::uuid and wallet_id=?::uuid)" : ""} order by created_at asc,id asc limit ?`, after ? [wallet.id, after, wallet.id, limit + 1] : [wallet.id, limit + 1]);
    const more = rows.length > limit;
    const entries = rows.slice(0, limit);
    return {
      walletId: wallet.id,
      items: entries.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        createdAt: new Date(row.created_at).toISOString(),
      })),
      nextCursor: more
        ? encodeLedgerCursor(wallet.id, entries.at(-1)!.id)
        : null,
    };
  }
  async reconcile(walletId: string, correlationId: string) {
    // Uma única instrução enxerga saldo e ledger no mesmo snapshot PostgreSQL.
    const rows = await this.orm.em
      .fork()
      .getConnection()
      .execute<
        Array<{
          wallet_id: string;
          currency: string;
          stored_balance: string;
          calculated_balance: string;
          difference: string;
          checked_entries: string;
          currency_conflicts: string;
        }>
      >(
        `
   select w.id as wallet_id,w.currency,w.balance::text as stored_balance,
   coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0)::text as calculated_balance,
   (w.balance-coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0))::text as difference,
   count(l.id)::text as checked_entries,count(l.id) filter (where l.currency<>w.currency)::text as currency_conflicts
   from wallets w left join wallet_ledger l on l.wallet_id=w.id where w.id=?::uuid group by w.id`,
        [walletId],
      );
    const row = rows[0];
    if (!row) throw new NotFoundException({ code: "WALLET_NOT_FOUND" });
    const consistent =
      new ExactDecimal(row.difference).isZero() &&
      row.currency_conflicts === "0";
    telemetry.inc("wager_reconciliation_total", {
      consistent: String(consistent),
    });
    operationalLog(
      consistent ? "wallet_reconciled" : "wallet_reconciliation_mismatch",
      {
        walletId: row.wallet_id,
        correlationId,
        consistent,
        checkedEntries: Number(row.checked_entries),
      },
    );
    const money = (value: string) => ({
      amount: new ExactDecimal(value).toFixed(2),
      currency: row.currency,
    });
    return {
      walletId: row.wallet_id,
      storedBalance: money(row.stored_balance),
      calculatedBalance: money(row.calculated_balance),
      difference: money(row.difference),
      consistent,
      checkedEntries: Number(row.checked_entries),
      currencyConflicts: Number(row.currency_conflicts),
    };
  }
}
