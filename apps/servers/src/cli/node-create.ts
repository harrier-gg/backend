// Registers a node and prints its agent token once (ADR 0004).
// Usage: npm run node:create --workspace @harrier-gg/servers -- --name <name>   (or: just node-create <name>)
import { parseArgs } from 'node:util';
import { createDb } from '../db';
import { formatToken, newSecret } from '../node-token';

async function main() {
  const { values } = parseArgs({ options: { name: { type: 'string' } } });
  const name = values.name ?? '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    console.error('Usage: node-create --name <name>   (1–64 characters: letters, digits, ".", "_", "-")');
    process.exit(1);
  }

  const db = createDb();
  try {
    const { secret, hash } = newSecret();
    const node = await db.node.create({ data: { name, tokenHash: hash } });
    console.log(`Node "${node.name}" registered (${node.id}).`);
    console.log('\nAgent token (shown only once, store it now):\n');
    console.log(`  ${formatToken(node.id, secret)}\n`);
    console.log('Start the agent with:  HARRIER_AGENT_TOKEN=<token> harrier agent run --panel <ws-url>');
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      console.error(`A node named "${name}" already exists.`);
      process.exit(1);
    }
    throw error;
  } finally {
    await db.$disconnect();
  }
}

void main();
