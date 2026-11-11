import { defineConfig } from 'prisma/config';

// Default only for local development (compose.dev.yaml). Real deployments always set HARRIER_DATABASE_URL.
const url = process.env.HARRIER_DATABASE_URL ?? 'postgresql://harrier:harrier@localhost:5433/harrier';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url },
});
