import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const port = Number(
          config.getOrThrow<string>('POSTGRES_PORT'),
        );

        if (
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535
        ) {
          throw new Error('POSTGRES_PORT deve ser uma porta válida.');
        }

        return {
          driver: PostgreSqlDriver,
          host: config.getOrThrow<string>('POSTGRES_HOST'),
          port,
          dbName: config.getOrThrow<string>('POSTGRES_DB'),
          user: config.getOrThrow<string>('POSTGRES_USER'),
          password: config.getOrThrow<string>('POSTGRES_PASSWORD'),
          entities: [],
          discovery: {
            warnWhenNoEntities: false,
          },
        };
      },
    }),
  ],
})
export class DatabaseModule {}