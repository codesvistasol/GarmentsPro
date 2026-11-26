import type { Prisma } from '@prisma/client';

export async function inactiveCategoryIds(db: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE inactive AS (
      SELECT id FROM "Category" WHERE NOT active
      UNION
      SELECT c.id FROM "Category" c JOIN inactive a ON c."parentId" = a.id
    )
    SELECT id FROM inactive
  `;
  return rows.map(row => row.id);
}
