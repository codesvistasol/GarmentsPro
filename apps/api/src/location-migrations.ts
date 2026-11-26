import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export function branchUrl(schema: string) {
  if (!/^branch_[a-f0-9]{24}$/.test(schema)) throw new Error('Invalid branch schema');
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', '3');
  return url.toString();
}

export async function deployMigrations(databaseUrl: string) {
  const prisma = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const schema = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
  await promisify(execFile)(process.execPath, [prisma, 'migrate', 'deploy', '--schema', schema], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 90000, windowsHide: true,
  });
}
