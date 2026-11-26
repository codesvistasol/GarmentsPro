import { branchUrl, deployMigrations } from './location-migrations.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { attributed, staffContext } from './staff-context.js';
import { RequestError, wrap } from './warehouse.js';
import { cents, decimal } from './sales-money.js';

export const locationContext = new AsyncLocalStorage<PrismaClient>();
export const modules = ['Dashboard','Quick Sale','Products','Categories','Inventory / Stock','Purchases','Sales & Distribution','Customers / Suppliers','Payments','Reports','Day Look','Activity Logs','Returns'] as const;
const branchClients = new Map<string, PrismaClient>();
export function branchClient(schema: string) {
  const existing = branchClients.get(schema);
  if (existing) return existing;
  const client = new PrismaClient({ datasourceUrl: branchUrl(schema) });
  branchClients.set(schema, client);
  return client;
}

export function operationalClient(central: PrismaClient) {
  return new Proxy(central, {
    get(target, key) {
      const selected = locationContext.getStore() ?? target;
      const value = Reflect.get(selected, key);
      return typeof value === 'function' ? value.bind(selected) : value;
    },
  });
}

const name = z.string().trim().min(2).max(100);
const grant = z.object({
  username: z.string().trim().min(1).max(254).transform(value => value.toLowerCase()),
  permissions: z.array(z.enum(modules)).max(modules.length),
  manager: z.boolean().default(false),
}).strict();
const identities = { id: true, username: true, displayName: true } as const;

export function locationRoutes(central: PrismaClient) {
  const router = Router();
  router.get('/locations', wrap(async (_req, res) => {
    const actor = staffContext.getStore()!;
    const user = await central.staffUser.findUniqueOrThrow({ where: { id: actor.id } });
    const globalAdmin = user.role === 'ADMIN';
    const branches = await central.branch.findMany({
      where: { ready: true, ...(globalAdmin ? {} : { access: { some: { userId: user.id } } }) },
      select: { id: true, name: true, shop: { select: { id: true, name: true } },
        access: { where: { userId: user.id }, select: { permissions: true, manager: true } } },
      orderBy: [{ shop: { name: 'asc' } }, { name: 'asc' }],
    });
    const shops = globalAdmin ? await central.shop.findMany({ orderBy: { name: 'asc' } }) : [];
    res.set('Cache-Control', 'no-store').json({ shops, legacyAllowed: !user.branchOnly || globalAdmin,
      branches: branches.map(({ access, ...branch }) => ({ ...branch,
        permissions: globalAdmin ? modules : access[0].permissions, manager: globalAdmin || access[0].manager })) });
  }));
  router.get('/locations/summary', wrap(async (_req, res) => {
    const actor = staffContext.getStore()!;
    const admin = actor.role === 'ADMIN';
    const branches = await central.branch.findMany({
      where: { ready: true, ...(admin ? {} : { access: { some: { userId: actor.id, permissions: { has: 'Reports' } } } }) },
      include: { shop: true }, orderBy: [{ shop: { name: 'asc' } }, { name: 'asc' }],
    });
    const results = [];
    for (const branch of branches) {
      const db = branchClient(branch.schemaName);
      const [stock, incoming, outgoing, sales, payments] = await db.$transaction([
        db.variant.aggregate({ _sum: { availableQty: true } }),
        db.stockMovement.aggregate({ where: { quantity: { gt: 0 } }, _sum: { quantity: true } }),
        db.stockMovement.aggregate({ where: { quantity: { lt: 0 } }, _sum: { quantity: true } }),
        db.salesOrder.aggregate({ _sum: { billed: true, credited: true, refunded: true, pendingRefund: true } }),
        db.salesPayment.aggregate({ _sum: { amount: true } }),
      ], { isolationLevel: 'RepeatableRead' });
      const billed = cents(sales._sum.billed ?? '0');
      const credited = cents(sales._sum.credited ?? '0');
      const paid = cents(payments._sum.amount ?? '0');
      const refunded = cents(sales._sum.refunded ?? '0');
      const pending = cents(sales._sum.pendingRefund ?? '0');
      results.push({ id: branch.id, name: branch.name, shop: branch.shop,
        onHand: stock._sum.availableQty ?? 0, stockIn: incoming._sum.quantity ?? 0,
        stockOut: Math.abs(outgoing._sum.quantity ?? 0), netSales: decimal(billed - credited),
        payments: decimal(paid - refunded), balance: decimal(billed - credited - paid + refunded + pending) });
    }
    res.set('Cache-Control','no-store').json(results);
  }));
  router.post('/locations/shops', wrap(async (req, res) => {
    if (staffContext.getStore()?.role !== 'ADMIN') throw new RequestError(403, 'Administrator access is required');
    const data = z.object({ name }).strict().parse(req.body);
    res.status(201).json(await attributed(central, tx => tx.shop.create({ data })));
  }));
  router.post('/locations/branches', wrap(async (req, res) => {
    if (staffContext.getStore()?.role !== 'ADMIN') throw new RequestError(403, 'Administrator access is required');
    const data = z.object({ name, shopId: z.string().min(1).max(50) }).strict().parse(req.body);
    const schemaName = 'branch_' + randomBytes(12).toString('hex');
    const branch = await central.branch.create({ data: { ...data, schemaName }, include: { shop: true } });
    try {
      await deployMigrations(branchUrl(schemaName));
      await branchClient(schemaName).businessSettings.create({
        data: { id: 'workspace', companyName: branch.shop.name },
      });
    } catch {
      await central.branch.delete({ where: { id: branch.id } });
      throw new RequestError(503, 'Branch database setup failed. Please try again.');
    }
    await central.branch.update({ where: { id: branch.id }, data: { ready: true } });
    res.status(201).json({ id: branch.id, name: branch.name });
  }));
  router.get('/locations/branches/:id/access', wrap(async (req, res) => {
    const actor = staffContext.getStore()!;
    await manageBranch(central, actor.id, actor.role === 'ADMIN', req.params.id);
    res.json(await central.branchAccess.findMany({ where: { branchId: req.params.id },
      select: { permissions: true, manager: true, user: { select: identities } }, orderBy: { user: { username: 'asc' } } }));
  }));
  router.put('/locations/branches/:id/access', wrap(async (req, res) => {
    const actor = staffContext.getStore()!;
    const branchId = req.params.id;
    const admin = actor.role === 'ADMIN';
    const data = grant.parse(req.body);
    await attributed(central, async tx => {
      await tx.$queryRaw`SELECT id FROM "Branch" WHERE id = ${branchId} FOR UPDATE`;
      const allowed = await manageBranch(tx, actor.id, admin, branchId);
      const target = await tx.staffUser.findUnique({ where: { username: data.username } });
      if (!target?.active || target.role === 'ADMIN') throw new RequestError(400, 'Use an active non-admin staff account');
      const where = { branchId_userId: { branchId, userId: target.id } };
      const previous = await tx.branchAccess.findUnique({ where });
      if (!admin && (!target.branchOnly || previous?.manager || data.manager || data.permissions.some(module => !allowed.includes(module)))) {
        throw new RequestError(403, 'You can grant only your own modules to branch staff');
      }
      const changes = { manager: data.manager, permissions: [...new Set(data.permissions)] };
      await tx.branchAccess.upsert({ where, create: { branchId, userId: target.id, ...changes }, update: changes });
      await tx.staffUser.update({ where: { id: target.id }, data: { branchOnly: true } });
      await tx.staffSession.deleteMany({ where: { userId: target.id } });
    });
    res.status(204).end();
  }));
  router.delete('/locations/branches/:id/access/:userId', wrap(async (req, res) => {
    const actor = staffContext.getStore()!;
    const branchId = req.params.id;
    await attributed(central, async tx => {
      await tx.$queryRaw`SELECT id FROM "Branch" WHERE id = ${branchId} FOR UPDATE`;
      await manageBranch(tx, actor.id, actor.role === 'ADMIN', branchId);
      const removed = await tx.branchAccess.deleteMany({ where: { branchId, userId: req.params.userId,
        ...(actor.role === 'ADMIN' ? {} : { manager: false }) } });
      if (!removed.count) throw new RequestError(404, 'Branch access not found');
      await tx.staffSession.deleteMany({ where: { userId: req.params.userId } });
    });
    res.status(204).end();
  }));
  return router;
}

async function manageBranch(db: Pick<PrismaClient,'branch'|'branchAccess'>, userId: string, admin: boolean, branchId: string) {
  if (admin) {
    const branch = await db.branch.findFirst({ where: { id: branchId, ready: true }, select: { id: true } });
    if (branch) return [...modules];
  } else {
    const membership = await db.branchAccess.findFirst({ where: { branchId, userId, manager: true, branch: { ready: true } } });
    if (membership) return membership.permissions;
  }
  throw new RequestError(403, 'Branch management access is required');
}
