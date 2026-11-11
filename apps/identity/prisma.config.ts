import { defineConfig } from 'prisma/config';

// Default only for local development (compose.dev.yaml). Real deployments always set HARRIER_DATABASE_URL.
const url = new URL(process.env.HARRIER_DATABASE_URL ?? 'postgresql://harrier:harrier@localhost:5433/harrier');
// Each service keeps its migration history in its own schema, so services never see (or reset)
// each other's migrations, even when they share one Postgres database.
url.searchParams.set('schema', 'identity');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: url.toString() },
});
