import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './config';
import { PrismaClient } from './generated/prisma/client';

export function createDb() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: config.HARRIER_DATABASE_URL }) });
}

export type Db = ReturnType<typeof createDb>;
