import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { branchUrl, deployMigrations } from './location-migrations.js';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL to the original workspace before running this command.');
  const database = new URL(databaseUrl);
  if (/^branch_/.test(database.searchParams.get('schema') ?? '')) {
    throw new Error('Use the original workspace schema as DATABASE_URL.');
  }

  try { await deployMigrations(databaseUrl); }
  catch { throw new Error('Original workspace migration failed. Inspect Prisma migrate status for this database.'); }
  console.log('Original workspace is up to date.');

  const db = new PrismaClient();
  try {
    const branches = await db.branch.findMany({
      where: { ready: true }, select: { schemaName: true, name: true, shop: { select: { name: true } } },
      orderBy: { schemaName: 'asc' },
    });
    const failures = [];
    for (const branch of branches) {
      const label = JSON.stringify(branch.shop.name + ' / ' + branch.name);
      try {
        await deployMigrations(branchUrl(branch.schemaName));
        console.log(label + ' is up to date.');
      } catch {
        console.error(label + ' failed migration (' + branch.schemaName + ').');
        failures.push(branch.schemaName);
      }
    }
    if (failures.length) throw new Error(failures.length + ' branch migrations failed. Resolve the failures before restarting the API.');
    console.log('Verified ' + branches.length + ' branch schema(s).');
  } finally { await db.$disconnect(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Database migration failed.');
  process.exitCode = 1;
});
