import { Router } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { cents, decimal } from './sales-money.js';
import { dateBounds, dateFilters } from './date-filters.js';
import { wrap } from './warehouse.js';

const date = z.string().date();
const areas = ['Catalogue','Inventory','Purchases','Sales','Payments','Customers','Settings'] as const;
const pageInput = z.object({
  search: z.string().trim().max(100).default(''),
  area: z.enum(areas).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
const money = (value: Prisma.Decimal | null) => decimal(cents(value ?? '0'));

export function activityRoutes(db: PrismaClient) {
  const router = Router();
  router.get('/activity-logs', wrap(async (req, res) => {
    const { area, search, page } = pageInput.parse(req.query);
    const match = { contains: search, mode: 'insensitive' as const };
    const where: Prisma.ActivityLogWhereInput = {
      area, createdAt: dateBounds(dateFilters.parse(req.query)),
      OR: search ? [{ reference: match }, { action: match }, { entityId: match }, { actorName: match }] : undefined,
    };
    const [rows, total] = await db.$transaction([
      db.activityLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 25, take: 25 }),
      db.activityLog.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    res.json({ items: rows.map(row => ({ ...row, id: String(row.id) })), total, page });
  }));

  router.get('/day-look', wrap(async (req, res) => {
    const day = date.default(new Date().toISOString().slice(0, 10)).parse(req.query.day);
    const { gte, lt } = dateBounds({ from: day, to: day });
    const createdAt = { gte, lt };
    const [sales, returns, payments, damage, receipts, ledgerRows, incoming, outgoing, settlements, buyers] = await db.$transaction([
      db.salesDispatch.aggregate({ where: { createdAt }, _sum: { total: true }, _count: { _all: true } }),
      db.salesReturn.aggregate({ where: { createdAt }, _sum: { credit: true, refunded: true }, _count: { _all: true } }),
      db.salesPayment.aggregate({ where: { createdAt }, _sum: { amount: true }, _count: { _all: true } }),
      db.stockMovement.aggregate({ where: { createdAt, type: 'DAMAGE' }, _sum: { quantity: true } }),
      db.goodsReceipt.count({ where: { receivedAt: createdAt } }),
      db.stockMovement.findMany({ where: { createdAt }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20,
        select: { id: true, createdAt: true, type: true, quantity: true, balanceAfter: true, reference: true, variant: { select: { sku: true } } },
      }),
      // Adjustments can have either sign, so direction is calculated per row.
      db.stockMovement.aggregate({ where: { createdAt, quantity: { gt: 0 } }, _sum: { quantity: true } }),
      db.stockMovement.aggregate({ where: { createdAt, quantity: { lt: 0 } }, _sum: { quantity: true } }),
      db.refundSettlement.aggregate({ where: { createdAt }, _sum: { amount: true } }),
      db.salesDispatch.findMany({ where: { createdAt }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30,
        select: { id: true, reference: true, destination: true, total: true, createdAt: true,
          order: { select: { customerName: true, number: true } } } }),
    ], { isolationLevel: 'RepeatableRead' });
    res.json({
      day, dispatches: sales._count._all, sales: money(sales._sum.total),
      returns: returns._count._all, returnCredits: money(returns._sum.credit),
      refundsRecorded: decimal(cents(returns._sum.refunded ?? '0') + cents(settlements._sum.amount ?? '0')),
      netSales: decimal(cents(sales._sum.total ?? '0') - cents(returns._sum.credit ?? '0')),
      paymentCount: payments._count._all, payments: money(payments._sum.amount),
      stockIn: incoming._sum.quantity ?? 0, stockOut: Math.abs(outgoing._sum.quantity ?? 0),
      damaged: Math.abs(damage._sum.quantity ?? 0),
      receipts, ledgerRows, buyers,
    });
  }));
  return router;
}
