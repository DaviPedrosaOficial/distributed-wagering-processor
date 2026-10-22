import { Type } from "class-transformer";
import { IsIn, IsObject, ValidateIf, IsString, IsUUID, Matches, MaxLength, ValidateNested, } from "class-validator";
import { InitialBalanceDto } from "../../wallets/http/create-wallet.dto.js";
import { WagerTransactionKind } from "../domain/wager-transaction.js";

export class SubmitTransactionDto {
  @IsString() @Matches(/\S/) @MaxLength(255) providerId!: string;
  @IsString() @Matches(/\S/) @MaxLength(255) externalTransactionId!: string;
  @IsUUID() walletId!: string;
  @IsUUID() playerId!: string;
  @IsString() @Matches(/\S/) @MaxLength(255) roundId!: string;
  @IsString() @Matches(/\S/) @MaxLength(255) gameId!: string;
  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;
  @IsObject()
  @ValidateNested()
  @Type(() => InitialBalanceDto)
  money!: InitialBalanceDto;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @MaxLength(255)
  referenceExternalTransactionId?: string;
}
