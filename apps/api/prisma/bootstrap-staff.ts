import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword, password, username } from '../src/staff.js';

const db = new PrismaClient();
try {
  const name = username.parse(process.env.GARMENTPRO_ADMIN_USERNAME);
  const secret = password.parse(process.env.GARMENTPRO_ADMIN_PASSWORD);
  const passwordHash = await hashPassword(secret);
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(848327)`;
    if (await tx.staffUser.count() > 0) throw new Error('Initial staff setup already completed');
    await tx.staffUser.create({ data: { username: name, displayName: 'Administrator', role: 'ADMIN', passwordHash } });
  });
  console.log('Initial administrator created.');
} finally {
  await db.$disconnect();
}
