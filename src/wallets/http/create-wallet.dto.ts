import { Type } from "class-transformer";
import { IsIn, IsObject, IsString, IsUUID, Matches, MaxLength, ValidateNested, } from "class-validator";

export class InitialBalanceDto {
  @IsString()
  @MaxLength(21)
  @Matches(/^\d+\.\d{2}$/)
  amount!: string;

  @IsIn(["BRL", "USD"])
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => InitialBalanceDto)
  initialBalance!: InitialBalanceDto;
}
