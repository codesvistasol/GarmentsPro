import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, PrismaClient, StaffRole } from '@prisma/client';

export type Actor = { id: string; displayName: string; username: string; role: StaffRole };
export const staffContext = new AsyncLocalStorage<Actor>();
export const testAuthBypass = () => process.env.NODE_ENV === 'test' && process.env.GARMENTPRO_TEST_ALLOW_UNAUTHENTICATED === '1';

export function attributed<T>(db: PrismaClient, run: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeout: number }) {
  return db.$transaction(async tx => {
    const actor = staffContext.getStore();
    if (actor) await tx.$queryRaw`SELECT set_config('garmentpro.actor_id', ${actor.id}, true),
      set_config('garmentpro.actor_name', ${actor.displayName}, true)`;
    return run(tx);
  }, options);
}
