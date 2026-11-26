import { attributed, testAuthBypass } from './staff-context.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { CustomerType, PaymentMethod, Prisma, ReturnCondition, SalesStatus, type PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { recordMovement, RequestError, wrap, quantity } from './warehouse.js';
import { allocate, cents, decimal } from './sales-money.js';
import { invoicePdf } from './invoice.js';
import { dateBounds, dateFilters } from './date-filters.js';
import { inactiveCategoryIds } from './catalogue-visibility.js';

// Keep API money strings in decimal notation throughout the database column range.
Prisma.Decimal.set({ toExpPos: 24 });

const id = z.string().trim().min(1).max(100);
const reference = z.string().trim().min(1).max(80);
const longText = z.string().trim().min(1).max(500);
const optional = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const date = z.string().date().transform(value => new Date(value + 'T00:00:00.000Z'));
const price = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const amount = z.string().regex(/^\d{1,22}(\.\d{1,2})?$/);
const customerInput = z.object({
  businessName: z.string().trim().min(2).max(120), type: z.nativeEnum(CustomerType),
  contactName: optional(120), email: z.string().trim().email().max(254).nullable().optional(),
  phone: optional(50), address: optional(500), creditLimit: price.default('0'),
  creditDays: z.number().int().min(0).max(3650).default(0),
}).strict();

function unique<T>(items: T[], key: (item: T) => string) {
  return new Set(items.map(key)).size === items.length;
}

const orderInput = z.object({
  number: reference, customerId: id, reserveStock: z.boolean().default(true), dueDate: date.optional(),
  items: z.array(z.object({ variantId: id, quantity, unitPrice: price, discount: amount.default('0') }).strict())
    .min(1).max(100).refine(items => unique(items, item => item.variantId), 'Variants must be unique'),
}).strict();
const request = z.object({ reference, requestKey: z.string().uuid() });
const line = z.object({ itemId: id, quantity }).strict();
const dispatchInput = request.extend({
  destination: longText,
  lines: z.array(line).min(1).max(100).refine(lines => unique(lines, item => item.itemId), 'Items must be unique'),
}).strict();
const returnInput = request.extend({
  reason: longText,
  lines: z.array(line.extend({ condition: z.nativeEnum(ReturnCondition) })).min(1).max(100)
    .refine(lines => unique(lines, item => item.itemId), 'Items must be unique'),
}).strict();
const paymentInput = request.extend({ amount, method: z.nativeEnum(PaymentMethod) }).strict();
const checkoutInput = z.object({
  requestKey: z.string().uuid().transform(value => value.toLowerCase()),
  customerId: id.optional(),
  destination: longText.default('Shop counter'),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  items: orderInput.shape.items,
}).strict();

const orderInfo = {
  items: { orderBy: { variantSku: 'asc' } },
  dispatches: { include: { lines: true }, orderBy: { createdAt: 'desc' } },
  payments: { orderBy: { createdAt: 'desc' } },
  returns: { include: { lines: true, settlements: true }, orderBy: { createdAt: 'desc' } },
  events: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.SalesOrderInclude;

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SalesOrder" WHERE id = ${orderId} FOR UPDATE`;
  if (!locked.length) throw new RequestError(404, 'Sales order not found');
  return tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
}

async function lockVariants(tx: Prisma.TransactionClient, ids: string[]) {
  const rows = await tx.$queryRaw<{ id: string; availableQty: number; reservedQty: number }[]>`
    SELECT id, "availableQty", "reservedQty"
    FROM "Variant" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
  `;
  return new Map(rows.map(variant => [variant.id, variant]));
}

async function event(tx: Prisma.TransactionClient, orderId: string, action: string, reference?: string) {
  await tx.salesEvent.create({ data: { orderId, action, reference } });
}

async function createOrder(tx: Prisma.TransactionClient, input: z.infer<typeof orderInput>, enforceCataloguePrice = false) {
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${input.customerId} FOR UPDATE`;
  const customer = await tx.customer.findFirst({ where: { id: input.customerId, archived: false } });
  if (!customer) throw new RequestError(400, 'Select an active customer');
  const variants = await tx.variant.findMany({
    where: { id: { in: input.items.map(item => item.variantId) }, product: {
      archived: false, active: true, categoryId: { notIn: await inactiveCategoryIds(tx) },
    } },
    include: { product: true },
  });
  const byId = new Map(variants.map(variant => [variant.id, variant]));
  let subtotal = 0n;
  let total = 0n;
  const items = input.items.map(item => {
    const variant = byId.get(item.variantId);
    if (!variant) throw new RequestError(400, 'Select active product variants');
    if (enforceCataloguePrice && cents(item.unitPrice) !== cents(variant.product.salePrice)) {
      throw new RequestError(409, 'Selling price changed for ' + variant.sku + '. Refresh the product and add it again.');
    }
    const gross = cents(item.unitPrice) * BigInt(item.quantity);
    const net = gross - cents(item.discount);
    if (net < 0n) throw new RequestError(400, 'A line discount exceeds its subtotal');
    subtotal += gross;
    total += net;
    return { ...item, total: decimal(net), unitCost: variant.product.costPrice, variantSku: variant.sku, productName: variant.product.name, size: variant.size, color: variant.color };
  });
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = input.dueDate ?? new Date(Date.parse(today) + customer.creditDays * 86_400_000);
  const created = await tx.salesOrder.create({
    data: {
      number: input.number, customerId: customer.id, customerName: customer.businessName,
      customerContact: customer.contactName, customerEmail: customer.email, customerPhone: customer.phone,
      customerAddress: customer.address, reserveStock: input.reserveStock, dueDate,
      subtotal: decimal(subtotal), total: decimal(total), items: { create: items },
    }, include: orderInfo,
  });
  await event(tx, created.id, 'CREATED', created.number);
  return created;
}

async function postDispatch(tx: Prisma.TransactionClient, orderId: string, { lines, ...input }: z.infer<typeof dispatchInput>) {
  const order = await lockOrder(tx, orderId);
  if (await tx.salesDispatch.findUnique({ where: { requestKey: input.requestKey } })) {
    throw new RequestError(409, 'Dispatch request already posted');
  }
  if (!['CONFIRMED', 'PARTIALLY_DISPATCHED'].includes(order.status)) throw new RequestError(409, 'Confirm an open order before dispatch');
  const items = new Map(order.items.map(item => [item.id, item]));
  const selected = lines.map(line => {
    const item = items.get(line.itemId);
    if (!item || item.dispatched + line.quantity > item.quantity) throw new RequestError(409, 'Dispatch exceeds the outstanding order quantity');
    return { item, quantity: line.quantity, amount: allocate(cents(item.total), item.quantity, item.dispatched, line.quantity) };
  });
  const stock = await lockVariants(tx, selected.map(line => line.item.variantId));
  const net = selected.reduce((sum, line) => sum + line.amount, 0n);
  const issuer = await tx.businessSettings.findUnique({ where: { id: 'workspace' } });
  const dispatched = await tx.salesDispatch.create({
    data: { ...input, orderId: order.id, total: decimal(net), issuer: issuer ?? undefined,
      lines: { create: selected.map(({ item, quantity, amount }) => ({ itemId: item.id, quantity, amount: decimal(amount) })) },
    },
    include: { lines: true },
  });
  for (const { item, quantity } of selected) {
    const variant = stock.get(item.variantId)!;
    if (order.reserveStock) {
      await tx.variant.update({ where: { id: item.variantId }, data: { reservedQty: { decrement: quantity } } });
    } else if (variant.availableQty - variant.reservedQty < quantity) {
      throw new RequestError(409, 'Insufficient unreserved stock for ' + item.variantSku);
    }
    await recordMovement(tx, {
      variantId: item.variantId, type: 'STOCK_OUT', quantity: -quantity,
      reason: 'Sales dispatch ' + order.number, reference: input.reference, destination: input.destination,
    });
    await tx.salesItem.update({ where: { id: item.id }, data: { dispatched: { increment: quantity } } });
  }
  const counts = new Map(lines.map(line => [line.itemId, line.quantity]));
  const complete = order.items.every(item => item.dispatched + (counts.get(item.id) ?? 0) === item.quantity);
  await tx.salesOrder.update({ where: { id: order.id }, data: {
    status: complete ? 'DISPATCHED' : 'PARTIALLY_DISPATCHED', billed: { increment: decimal(net) },
  } });
  await event(tx, order.id, 'DISPATCHED', input.reference);
  return dispatched;
}

async function postPayment(tx: Prisma.TransactionClient, orderId: string, input: z.infer<typeof paymentInput>) {
  const order = await lockOrder(tx, orderId);
  if (await tx.salesPayment.findUnique({ where: { requestKey: input.requestKey } })) throw new RequestError(409, 'Payment already posted');
  const remaining = cents(order.billed) - cents(order.credited) - cents(order.paid) + cents(order.refunded) + cents(order.pendingRefund);
  if (cents(input.amount) > remaining) throw new RequestError(409, 'Payment exceeds the balance due');
  const payment = await tx.salesPayment.create({ data: { ...input, orderId: order.id } });
  await tx.salesOrder.update({ where: { id: order.id }, data: { paid: { increment: input.amount } } });
  await event(tx, order.id, 'PAYMENT', input.reference);
  return payment;
}

function requireReturnPermission(supplied?: string) {
  const expected = process.env.SALES_RETURN_KEY;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  if (!expected || !supplied || !timingSafeEqual(hash(expected), hash(supplied))) {
    throw new RequestError(403, 'Return operator authorization is required');
  }
}

export function salesRoutes(db: PrismaClient) {
  const router = Router();
  router.get('/customers', wrap(async (req, res) => {
    const { search, type, status } = z.object({
      search: z.string().trim().max(120).default(''), type: z.nativeEnum(CustomerType).optional(),
      status: z.enum(['active', 'archived', 'all']).default('active'),
    }).parse(req.query);
    const match = { contains: search, mode: 'insensitive' as const };
    res.json(await db.customer.findMany({
      where: { type, archived: status === 'all' ? undefined : status === 'archived',
        OR: search ? [{ businessName: match }, { contactName: match }, { email: match }, { address: match }, { phone: match }] : undefined },
      orderBy: [{ businessName: 'asc' }, { id: 'asc' }],
    }));
  }));
  router.post('/customers', wrap(async (req, res) => {
    res.status(201).json(await attributed(db, tx => tx.customer.create({ data: customerInput.parse(req.body) })));
  }));
  router.patch('/customers/:id', wrap(async (req, res) => {
    res.json(await attributed(db, tx => tx.customer.update({ where: { id: req.params.id }, data: customerInput.partial().parse(req.body) })));
  }));
  router.delete('/customers/:id', wrap(async (req, res) => {
    await attributed(db, tx => tx.customer.update({ where: { id: req.params.id }, data: { archived: true } }));
    res.status(204).end();
  }));

  router.get('/sales-orders', wrap(async (req, res) => {
    const { customerId } = z.object({ customerId: id.optional() }).parse(req.query);
    res.json(await db.salesOrder.findMany({ where: { customerId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: orderInfo }));
  }));
  router.get('/sales-orders/:id', wrap(async (req, res) => {
    res.json(await db.salesOrder.findUniqueOrThrow({ where: { id: req.params.id }, include: orderInfo }));
  }));
  router.post('/sales-orders', wrap(async (req, res) => {
    const input = orderInput.parse(req.body);
    const order = await attributed(db, tx => createOrder(tx, input));
    res.status(201).json(order);
  }));

  router.post('/sales-checkout', wrap(async (req, res) => {
    const input = checkoutInput.parse(req.body);
    if (!input.customerId && !input.paymentMethod) throw new RequestError(400, 'Select a customer for a sale on account');
    const number = 'POS-' + input.requestKey.replace(/-/g, '').toUpperCase();
    const signature = createHash('sha256').update(JSON.stringify({
      ...input, items: [...input.items].sort((a, b) => a.variantId.localeCompare(b.variantId)),
    })).digest('hex');
    const result = await attributed(db, async tx => {
      // Serialize retries before reading or creating the order, including two requests in flight.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${number}))`;
      const existing = await tx.salesOrder.findUnique({ where: { number }, include: orderInfo });
      if (existing) {
        if (!existing.events.some(entry => entry.action === 'QUICK_SALE' && entry.reference === signature)) {
          throw new RequestError(409, 'This checkout reference was already used for a different sale');
        }
        return { order: existing, replayed: true };
      }
      const customerId = input.customerId ?? (await tx.customer.upsert({
        where: { id: 'garmentpro-walk-in' }, update: {},
        create: { id: 'garmentpro-walk-in', businessName: 'Walk-in customer', type: 'CUSTOMER' },
      })).id;
      const order = await createOrder(tx, { number, customerId, reserveStock: false, items: input.items }, true);
      await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'CONFIRMED' } });
      await event(tx, order.id, 'CONFIRMED', number);
      const dispatch = await postDispatch(tx, order.id, {
        reference: number, requestKey: input.requestKey, destination: input.destination,
        lines: order.items.map(item => ({ itemId: item.id, quantity: item.quantity })),
      });
      if (input.paymentMethod && cents(dispatch.total) > 0n) {
        await postPayment(tx, order.id, {
          reference: number + '-PAY', requestKey: input.requestKey,
          amount: dispatch.total.toFixed(2), method: input.paymentMethod,
        });
      }
      await event(tx, order.id, 'QUICK_SALE', signature);
      return { order: await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInfo }), replayed: false };
    }, { timeout: 15000 });
    res.status(result.replayed ? 200 : 201).json(result.order);
  }));

  router.post(['/sales-orders/:id/confirm', '/sales-orders/:id/cancel'], wrap(async (req, res) => {
    const confirm = req.path.endsWith('/confirm');
    const order = await attributed(db, async tx => {
      const order = await lockOrder(tx, req.params.id);
      const allowed = confirm ? order.status === 'DRAFT' : ['DRAFT', 'CONFIRMED', 'PARTIALLY_DISPATCHED'].includes(order.status);
      if (!allowed) throw new RequestError(409, 'Order cannot make that status transition');
      if (order.reserveStock && (confirm || order.status !== 'DRAFT')) {
        const outstanding = order.items.filter(item => item.dispatched < item.quantity);
        const stock = await lockVariants(tx, outstanding.map(item => item.variantId));
        for (const item of outstanding) {
          const variant = stock.get(item.variantId)!;
          const remaining = item.quantity - item.dispatched;
          if (confirm && variant.availableQty - variant.reservedQty < remaining) {
            throw new RequestError(409, 'Insufficient unreserved stock for ' + item.variantSku);
          }
          await tx.variant.update({
            where: { id: item.variantId },
            data: { reservedQty: { increment: confirm ? remaining : -remaining } },
          });
        }
      }
      const status = confirm ? 'CONFIRMED' : 'CANCELLED';
      await event(tx, order.id, status, order.number);
      return tx.salesOrder.update({ where: { id: order.id }, data: { status }, include: orderInfo });
    });
    res.json(order);
  }));

  router.post('/sales-orders/:id/dispatches', wrap(async (req, res) => {
    const input = dispatchInput.parse(req.body);
    const dispatch = await attributed(db, tx => postDispatch(tx, req.params.id, input), { timeout: 15000 });
    res.status(201).json(dispatch);
  }));

  router.post('/sales-orders/:id/payments', wrap(async (req, res) => {
    const input = paymentInput.parse(req.body);
    if (cents(input.amount) <= 0n) throw new RequestError(400, 'Payment must be positive');
    const payment = await attributed(db, tx => postPayment(tx, req.params.id, input));
    res.status(201).json(payment);
  }));

  router.post('/sales-orders/:id/returns', wrap(async (req, res) => {
    if (testAuthBypass()) requireReturnPermission(req.get('X-Return-Key'));
    const { lines, ...input } = returnInput.parse(req.body);
    const result = await attributed(db, async tx => {
      const order = await lockOrder(tx, req.params.id);
      if (await tx.salesReturn.findUnique({ where: { requestKey: input.requestKey } })) throw new RequestError(409, 'Return already posted');
      const items = new Map(order.items.map(item => [item.id, item]));
      const selected = lines.map(line => {
        const item = items.get(line.itemId);
        if (!item || item.returned + line.quantity > item.dispatched) throw new RequestError(409, 'Return exceeds the quantity dispatched and not yet returned');
        return { ...line, item, credit: allocate(cents(item.total), item.quantity, item.returned, line.quantity) };
      });
      const credit = selected.reduce((sum, line) => sum + line.credit, 0n);
      const balance = cents(order.billed) - cents(order.credited) - cents(order.paid) + cents(order.refunded) + cents(order.pendingRefund);
      const refund = credit > balance ? credit - balance : 0n;
      const saleReturn = await tx.salesReturn.create({
        data: {
          ...input, orderId: order.id, credit: decimal(credit), refunded: '0', refundDue: decimal(refund),
          lines: { create: selected.map(({ itemId, quantity, condition, credit }) => ({ itemId, quantity, condition, credit: decimal(credit) })) },
        },
        include: { lines: true },
      });
      const restocked = selected.filter(line => line.condition === 'SALEABLE');
      if (restocked.length) await lockVariants(tx, restocked.map(line => line.item.variantId));
      for (const line of selected) {
        if (line.condition === 'SALEABLE') await recordMovement(tx, {
          variantId: line.item.variantId, type: 'RETURN_IN', quantity: line.quantity,
          reason: input.reason, reference: input.reference,
        });
        await tx.salesItem.update({ where: { id: line.item.id }, data: { returned: { increment: line.quantity } } });
      }
      await tx.salesOrder.update({ where: { id: order.id }, data: {
        credited: { increment: decimal(credit) }, pendingRefund: { increment: decimal(refund) },
      } });
      await event(tx, order.id, 'RETURN', input.reference);
      return saleReturn;
    }, { timeout: 15000 });
    res.status(201).json(result);
  }));

  router.post('/sales-orders/:id/returns/:returnId/settlements', wrap(async (req, res) => {
    const input = paymentInput.parse(req.body);
    if (cents(input.amount) <= 0n) throw new RequestError(400, 'Refund must be positive');
    const settlement = await attributed(db, async tx => {
      const order = await lockOrder(tx, req.params.id);
      const existing = await tx.refundSettlement.findUnique({ where: { requestKey: input.requestKey } });
      if (existing) throw new RequestError(409, 'Refund settlement already posted');
      const record = await tx.salesReturn.findFirstOrThrow({
        where: { id: req.params.returnId, orderId: order.id }, include: { settlements: true },
      });
      const settled = record.settlements.reduce((sum, item) => sum + cents(item.amount), 0n);
      const remaining = cents(record.refundDue) - settled;
      if (cents(input.amount) > remaining) throw new RequestError(409, 'Refund exceeds the unsettled amount');
      const posted = await tx.refundSettlement.create({ data: { ...input, returnId: record.id } });
      await tx.salesOrder.update({ where: { id: order.id }, data: {
        pendingRefund: { decrement: input.amount }, refunded: { increment: input.amount },
      } });
      return posted;
    });
    res.status(201).json(settlement);
  }));

  router.get('/sales-invoices/:id.pdf', wrap(async (req, res) => {
    const dispatch = await db.salesDispatch.findUniqueOrThrow({
      where: { id: req.params.id }, include: { order: true, lines: { include: { item: true } } },
    });
    const view = z.literal('1').optional().parse(req.query.view);
    const filename = 'invoice-' + dispatch.id + '.pdf';
    res.setHeader('Content-Disposition', (view ? 'inline' : 'attachment') + '; filename=' + filename);
    const checkoutPayment = dispatch.reference === dispatch.order.number && dispatch.reference.startsWith('POS-')
      ? await db.salesPayment.findUnique({ where: { reference: dispatch.reference + '-PAY' } })
      : null;
    res.type('application/pdf').send(await invoicePdf(dispatch, checkoutPayment));
  }));

  router.get('/sales-dashboard', wrap(async (req, res) => {
    const createdAt = dateBounds(dateFilters.parse(req.query));
    const starts = createdAt.gte ? Prisma.sql`AND entry."createdAt" >= ${createdAt.gte}` : Prisma.empty;
    const ends = createdAt.lt ? Prisma.sql`AND entry."createdAt" < ${createdAt.lt}` : Prisma.empty;
    const [totals, movements, recent, stockFlow] = await db.$transaction([
      db.salesOrder.aggregate({ _sum: { billed: true, credited: true, paid: true, refunded: true, pendingRefund: true } }),
      db.$queryRaw<{ id: string; name: string; quantity: bigint; amount: Prisma.Decimal; cost: Prisma.Decimal; stock: bigint; estimatedCost: boolean }[]>`
        WITH activity AS (
          SELECT line."itemId", line.quantity, line.amount, line.quantity AS "costUnits"
          FROM "SalesDispatchLine" line JOIN "SalesDispatch" entry ON entry.id = line."dispatchId"
          WHERE TRUE ${starts} ${ends}
          UNION ALL
          SELECT line."itemId", -line.quantity, -line.credit,
            CASE WHEN line.condition = 'SALEABLE' THEN -line.quantity ELSE 0 END AS "costUnits"
          FROM "SalesReturnLine" line JOIN "SalesReturn" entry ON entry.id = line."returnId"
          WHERE TRUE ${starts} ${ends}
        )
        SELECT p.id, p.name, SUM(a.quantity) quantity, SUM(a.amount) amount,
          SUM(a."costUnits" * COALESCE(s."unitCost", p."costPrice")) cost,
          (SELECT COALESCE(SUM(vs."availableQty"), 0) FROM "Variant" vs WHERE vs."productId" = p.id) stock,
          BOOL_OR(s."unitCost" IS NULL AND a."costUnits" <> 0) "estimatedCost"
        FROM activity a JOIN "SalesItem" s ON s.id = a."itemId"
        JOIN "Variant" v ON v.id = s."variantId" JOIN "Product" p ON p.id = v."productId"
        GROUP BY p.id ORDER BY quantity DESC, p.id
      `,
      db.salesDispatch.findMany({
        where: { createdAt },
        select: { id: true, reference: true, total: true, createdAt: true, order: { select: { number: true, customerName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5,
      }),
      db.$queryRaw<{ incoming: bigint; outgoing: bigint; damaged: bigint; damageCost: Prisma.Decimal }[]>`
        SELECT COALESCE(SUM(entry.quantity) FILTER (WHERE entry.quantity > 0), 0) incoming,
          COALESCE(-SUM(entry.quantity) FILTER (WHERE entry.quantity < 0), 0) outgoing,
          COALESCE(-SUM(entry.quantity) FILTER (WHERE entry.type = 'DAMAGE'), 0) damaged,
          COALESCE(-SUM(entry.quantity * p."costPrice") FILTER (WHERE entry.type = 'DAMAGE'), 0) "damageCost"
        FROM "StockMovement" entry JOIN "Variant" v ON v.id = entry."variantId"
        JOIN "Product" p ON p.id = v."productId"
        WHERE TRUE ${starts} ${ends}
      `,
    ], { isolationLevel: 'RepeatableRead' });
    const sum = totals._sum;
    const netSales = movements.reduce((total, item) => total + cents(item.amount), 0n);
    const soldQuantity = movements.reduce((total, item) => total + item.quantity, 0n);
    const soldCost = movements.reduce((total, item) => total + cents(item.cost), 0n);
    const flow = stockFlow[0];
    const summarize = ({ id, name, quantity, stock, amount, cost }: (typeof movements)[number]) => ({
      id, name, quantity: Number(quantity), stock: Number(stock), sales: decimal(cents(amount)),
      soldCost: decimal(cents(cost)), grossProfit: decimal(cents(amount) - cents(cost)),
    });
    res.json({ totalSales: decimal(netSales), soldQuantity: Number(soldQuantity),
      soldCost: decimal(soldCost), grossProfit: decimal(netSales - soldCost),
      estimatedCost: movements.some(item => item.estimatedCost),
      stockIn: Number(flow.incoming), stockOut: Number(flow.outgoing), damaged: Number(flow.damaged),
      damageCostEstimate: decimal(cents(flow.damageCost)),
      pendingPayments: decimal(cents(sum.billed ?? '0') - cents(sum.credited ?? '0') - cents(sum.paid ?? '0') + cents(sum.refunded ?? '0') + cents(sum.pendingRefund ?? '0')),
      pendingRefunds: decimal(cents(sum.pendingRefund ?? '0')),
      topProducts: movements.filter(item => item.quantity > 0n).slice(0,5).map(summarize),
      productMargins: req.query.includeMargins === 'true' ? movements.map(summarize) : undefined,
      recent,
    });
  }));
  return router;
}
