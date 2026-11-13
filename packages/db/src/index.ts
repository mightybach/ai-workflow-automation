import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { Prisma, PrismaClient } from './generated/prisma/client.js';

// Creating the client does not execute a query or apply schema changes.
// The caller supplies DATABASE_URL and owns the client's $disconnect lifecycle.
export function createDatabaseClient(databaseUrl: string) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required to create a database client.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
