import { attributed, staffContext, testAuthBypass } from './staff-context.js';
import { MovementType, Prisma, type PrismaClient } from '@prisma/client';
import { Router, type RequestHandler, type Request, type Response } from 'express';
import { inactiveCategoryIds } from './catalogue-visibility.js';
import { z } from 'zod';

export class RequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export const wrap = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { Promise.resolve(handler(req, res)).catch(next); };

const maxInt = 2147483647;
export const quantity = z.number().int().min(1).max(maxInt);
export const threshold = z.number().int().min(0).max(maxInt);
const id = z.string().trim().min(1).max(100);
const reference = z.string().trim().min(1).max(80);
const description = z.string().trim().min(1).max(500);
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const date = z.string().date().transform(value => new Date(value + 'T00:00:00.000Z'));
const money = z.union([z.string(), z.number()]).transform(String)
  .pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/));

const supplierInput = z.object({
  company: z.string().trim().min(2).max(120),
  contactName: optionalText(120),
  email: z.string().trim().email().max(254).nullable().optional(),
  phone: optionalText(50),
  address: optionalText(500),
  taxNumber: optionalText(80),
  active: z.boolean().optional(),
}).strict();

function distinct<T>(items: T[], key: (item: T) => string) {
  return new Set(items.map(key)).size === items.length;
}

const orderInput = z.object({
  supplierId: id,
  reference,
  orderDate: date,
  items: z.array(z.object({ variantId: id, quantity, unitPrice: money }).strict()).min(1).max(100)
    .refine(items => distinct(items, item => item.variantId), 'Each variant can appear once per order'),
}).strict();

const receiptInput = z.object({
  reference,
  lines: z.array(z.object({ itemId: id, quantity }).strict()).min(1).max(100)
    .refine(lines => distinct(lines, line => line.itemId), 'Each item can appear once per receipt'),
}).strict();

const movementTypes = ['STOCK_IN', 'STOCK_OUT', 'RETURN_IN', 'RETURN_TO_SUPPLIER', 'DAMAGE', 'ADJUSTMENT'] as const;
const outboundTypes = new Set<MovementType>(['STOCK_OUT', 'RETURN_TO_SUPPLIER', 'DAMAGE']);
const movementInput = z.object({
  variantId: id,
  type: z.enum(movementTypes),
  quantity: z.number().int().min(-maxInt).max(maxInt),
  reason: description,
  destination: description.optional(),
  reference,
  requestKey: z.string().uuid(),
}).strict().superRefine((input, ctx) => {
  if (!input.quantity || (input.type !== 'ADJUSTMENT' && input.quantity < 0)) {
    ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Enter a positive quantity or a signed, nonzero adjustment' });
  }
  if (['STOCK_OUT', 'RETURN_TO_SUPPLIER'].includes(input.type) && !input.destination) {
    ctx.addIssue({ code: 'custom', path: ['destination'], message: 'Destination is required' });
  }
});

const historyInput = z.object({
  search: z.string().trim().max(100).optional(),
  productId: id.optional(),
  variantId: id.optional(),
  type: z.nativeEnum(MovementType).optional(),
  from: date.optional(),
  to: date.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
}).refine(input => !input.from || !input.to || input.from <= input.to, 'Invalid date range');

export async function recordMovement(
  tx: Prisma.TransactionClient,
  data: Omit<Prisma.StockMovementUncheckedCreateInput, 'balanceAfter'>,
) {
  const [variant] = await tx.$queryRaw<{ availableQty: number; reservedQty: number }[]>`
    SELECT "availableQty", "reservedQty" FROM "Variant" WHERE "id" = ${data.variantId} FOR UPDATE
  `;
  if (!variant) throw new RequestError(404, 'Variant not found');
  const balance = variant.availableQty + data.quantity;
  if (balance < variant.reservedQty) throw new RequestError(409, 'Insufficient available stock');
  if (balance > maxInt) throw new RequestError(409, 'Maximum stock balance exceeded');
  return tx.stockMovement.create({ data: { ...data, balanceAfter: balance, createdAt: new Date() } });
}

const orderInclude = {
  items: { orderBy: { variantSku: 'asc' as const } },
  receipts: { orderBy: { receivedAt: 'desc' as const }, include: { lines: true } },
} satisfies Prisma.PurchaseOrderInclude;

const movementInclude = { variant: { include: { product: true } } } satisfies Prisma.StockMovementInclude;
const newestFirst: Prisma.StockMovementOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

function csvCell(value: string | number | null) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function sendCsv(res: Response, filename: string, rows: (string | number | null)[][]) {
  res.attachment(filename).type('text/csv')
    .send(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}

export function warehouseRoutes(db: PrismaClient) {
  const router = Router();

  router.get('/suppliers', wrap(async (req, res) => {
    const search = z.string().trim().max(120).default('').parse(req.query.search);
    const match = { contains: search, mode: 'insensitive' as const };
    res.json(await db.supplier.findMany({
      where: search ? { OR: [{ company: match }, { contactName: match }, { email: match }, { phone: match }, { address: match }, { taxNumber: match }] } : undefined,
      orderBy: [{ company: 'asc' }, { id: 'asc' }],
    }));
  }));
  router.get('/suppliers/:id', wrap(async (req, res) => {
    res.json(await db.supplier.findUniqueOrThrow({ where: { id: req.params.id } }));
  }));
  router.post('/suppliers', wrap(async (req, res) => {
    res.status(201).json(await attributed(db, tx => tx.supplier.create({ data: supplierInput.parse(req.body) })));
  }));
  router.patch('/suppliers/:id', wrap(async (req, res) => {
    res.json(await attributed(db, tx => tx.supplier.update({ where: { id: req.params.id }, data: supplierInput.partial().parse(req.body) })));
  }));
  router.delete('/suppliers/:id', wrap(async (req, res) => {
    await attributed(db, tx => tx.supplier.update({ where: { id: req.params.id }, data: { active: false } }));
    res.status(204).end();
  }));

  router.get('/purchase-orders', wrap(async (_req, res) => {
    res.json(await db.purchaseOrder.findMany({ orderBy: [{ orderDate: 'desc' }, { id: 'desc' }], include: orderInclude }));
  }));
  router.get('/purchase-orders.csv', wrap(async (_req, res) => {
    const items = await db.purchaseItem.findMany({
      include: { order: true },
      orderBy: [{ order: { orderDate: 'desc' } }, { orderId: 'desc' }, { variantSku: 'asc' }],
    });
    sendCsv(res, 'purchase-orders.csv', [
      ['Order reference', 'Order date', 'Supplier', 'Product', 'Variant SKU', 'Size', 'Color', 'Ordered', 'Received', 'Outstanding', 'Unit price (PKR)'],
      ...items.map(item => [
        item.order.reference, item.order.orderDate.toISOString().slice(0, 10), item.order.supplierName, item.productName,
        item.variantSku, item.size, item.color, item.quantity, item.receivedQty, item.quantity - item.receivedQty,
        item.unitPrice.toFixed(2),
      ]),
    ]);
  }));
  router.get('/purchase-orders/:id', wrap(async (req, res) => {
    res.json(await db.purchaseOrder.findUniqueOrThrow({ where: { id: req.params.id }, include: orderInclude }));
  }));
  router.post('/purchase-orders', wrap(async (req, res) => {
    const input = orderInput.parse(req.body);
    const order = await attributed(db, async tx => {
      const [supplier] = await tx.$queryRaw<{ company: string; active: boolean }[]>`
        SELECT "company", "active" FROM "Supplier" WHERE "id" = ${input.supplierId} FOR UPDATE
      `;
      if (!supplier?.active) throw new RequestError(409, 'Select an active supplier');
      const variants = await tx.variant.findMany({
        where: { id: { in: input.items.map(item => item.variantId) }, product: { archived: false } },
        include: { product: true },
      });
      const byId = new Map(variants.map(variant => [variant.id, variant]));
      const items = input.items.map(item => {
        const variant = byId.get(item.variantId);
        if (!variant) throw new RequestError(400, 'Each purchase item must reference an active product variant');
        return { ...item, variantSku: variant.sku, productName: variant.product.name, size: variant.size, color: variant.color };
      });
      return tx.purchaseOrder.create({
        data: {
          supplierId: input.supplierId, supplierName: supplier.company, reference: input.reference,
          orderDate: input.orderDate, items: { create: items },
        },
        include: orderInclude,
      });
    });
    res.status(201).json(order);
  }));

  router.post('/purchase-orders/:id/receipts', wrap(async (req, res) => {
    const { reference, lines } = receiptInput.parse(req.body);
    const orderId = req.params.id;
    const receipt = await attributed(db, async tx => {
      const order = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
      const byId = new Map(order.items.map(item => [item.id, item]));
      const requested = lines.map(line => {
        const item = byId.get(line.itemId);
        if (!item) throw new RequestError(400, 'Receipt item does not belong to this purchase order');
        return { item, quantity: line.quantity };
      }).sort((left, right) => left.item.variantId.localeCompare(right.item.variantId));

      const receipt = await tx.goodsReceipt.create({ data: { orderId, reference } });
      for (const { item, quantity } of requested) {
        const updated = await tx.purchaseItem.updateMany({
          where: { id: item.id, receivedQty: { lte: item.quantity - quantity } },
          data: { receivedQty: { increment: quantity } },
        });
        if (!updated.count) throw new RequestError(409, 'Receipt exceeds the outstanding quantity');
        const line = await tx.receiptLine.create({ data: { receiptId: receipt.id, itemId: item.id, quantity } });
        await recordMovement(tx, { variantId: item.variantId, type: 'RECEIPT', quantity, reference, receiptLineId: line.id });
      }
      return tx.goodsReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { lines: true } });
    }, { timeout: 15000 });
    res.status(201).json(receipt);
  }));

  router.get('/inventory/variants', wrap(async (_req, res) => {
    const [variants, inactive] = await Promise.all([
      db.variant.findMany({ include: { product: { include: { image: { select: { productId: true } } } } }, orderBy: { sku: 'asc' } }),
      inactiveCategoryIds(db),
    ]);
    const blocked = new Set(inactive);
    res.json(variants.map(variant => ({
      ...variant, saleActive: !variant.product.archived && variant.product.active && !blocked.has(variant.product.categoryId),
    })));
  }));
  router.post('/inventory/variants', wrap(async (req, res) => {
    const { productId, ...data } = z.object({
      productId: id, sku: z.string().trim().min(2).max(80), size: optionalText(40).unwrap().unwrap(),
      color: optionalText(40).unwrap().unwrap(), reorderPoint: threshold.default(5),
    }).strict().parse(req.body);
    const product = await db.product.findFirst({ where: { id: productId, archived: false } });
    if (!product) throw new RequestError(404, 'Active product not found');
    res.status(201).json(await attributed(db, tx => tx.variant.create({ data: { ...data, productId } })));
  }));
  router.patch('/inventory/variants/:id', wrap(async (req, res) => {
    const data = z.object({ reorderPoint: threshold }).strict().parse(req.body);
    res.json(await attributed(db, tx => tx.variant.update({ where: { id: req.params.id }, data })));
  }));

  router.post('/inventory/movements', wrap(async (req, res) => {
    const { quantity, ...input } = movementInput.parse(req.body);
    if (input.type === 'RETURN_IN' && !testAuthBypass() && staffContext.getStore()?.role !== 'ADMIN') {
      throw new RequestError(403, 'Post customer returns against the sales order. Only an administrator can post an unlinked stock return.');
    }
    const delta = outboundTypes.has(input.type) ? -quantity : quantity;
    res.status(201).json(await attributed(db, tx => recordMovement(tx, { ...input, quantity: delta })));
  }));

  router.get(['/inventory/history', '/inventory/history.csv'], wrap(async (req, res) => {
    const { from, to, productId, variantId, type, page, search } = historyInput.parse(req.query);
    const match = { contains: search, mode: 'insensitive' as const };
    const where: Prisma.StockMovementWhereInput = {
      variantId, type, variant: productId ? { productId } : undefined,
      OR: search ? [{ reference: match }, { reason: match }, { destination: match },
        { variant: { sku: match } }, { variant: { product: { name: match } } }] : undefined,
      createdAt: { gte: from, lt: to ? new Date(to.getTime() + 86_400_000) : undefined },
    };
    const exportCsv = req.path.endsWith('.csv');
    if (!exportCsv) {
      const [items, total] = await db.$transaction([
        db.stockMovement.findMany({ where, include: movementInclude, orderBy: newestFirst, skip: (page - 1) * 50, take: 50 }),
        db.stockMovement.count({ where }),
      ], { isolationLevel: 'RepeatableRead' });
      return res.json({ items, total, page });
    }
    const header = ['Date (UTC)', 'Product', 'Variant SKU', 'Size', 'Color', 'Movement', 'Quantity change', 'Balance', 'Reason', 'Destination', 'Reference'];
    const items = await db.stockMovement.findMany({ where, include: movementInclude, orderBy: newestFirst });
    const rows = items.map(item => [
      item.createdAt.toISOString(), item.variant.product.name, item.variant.sku, item.variant.size, item.variant.color,
      item.type, item.quantity, item.balanceAfter, item.reason, item.destination, item.reference,
    ]);
    sendCsv(res, 'inventory-history.csv', [header, ...rows]);
  }));

  return router;
}
