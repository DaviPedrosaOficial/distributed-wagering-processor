import { IsString, Matches, MaxLength, ValidateIf } from "class-validator";

export class LedgerQueryDto {
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsString()
  @Matches(/^(?:[1-9]\d?|100)$/)
  limit?: string;
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}
