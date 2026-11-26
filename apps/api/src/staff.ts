import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router, type Request, type Response } from 'express';
import { StaffRole, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { RequestError, wrap } from './warehouse.js';
import { invoiceLogo } from './invoice.js';
import { attributed, staffContext, testAuthBypass, type Actor } from './staff-context.js';

const derive = promisify(scrypt);
export const username = z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/).transform(value => value.toLowerCase());
export const password = z.string().min(12).max(128);
const sessionName = 'garmentpro_session';
const maxAge = 8 * 60 * 60 * 1000;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
import { branchClient, locationContext, modules } from './locations.js';
const moduleInput = z.array(z.enum(modules)).max(modules.length).optional();
const defaults: Record<StaffRole, readonly string[]> = {
  ADMIN: modules,
  WAREHOUSE: ['Dashboard','Products','Categories','Inventory / Stock','Purchases','Sales & Distribution'],
  SALES: ['Quick Sale','Sales & Distribution','Customers / Suppliers','Payments'],
  FINANCE: ['Sales & Distribution','Payments','Reports','Day Look','Returns'],
};
function permissions(role: StaffRole, saved: unknown): readonly string[] {
  return role === 'ADMIN' || !Array.isArray(saved) ? defaults[role] : saved;
}
const users = { branchOnly: true, permissions: true, id: true, username: true, displayName: true, role: true, active: true, createdAt: true, signupPending: true } as const;

export async function hashPassword(secret: string) {
  const salt = randomBytes(16).toString('hex');
  return salt + '$' + (await derive(secret, salt, 32) as Buffer).toString('hex');
}

async function checkPassword(secret: string, hash?: string) {
  const [salt, expected] = (hash ?? ('0'.repeat(32) + '$' + '0'.repeat(64))).split('$');
  const computed = Buffer.from(await derive(secret, salt, 32) as Buffer);
  const target = Buffer.from(expected, 'hex');
  return computed.length === target.length && timingSafeEqual(computed, target) && Boolean(hash);
}

function sessionToken(req: Request) {
  const value = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(sessionName + '='))?.slice(sessionName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

const cookie = () => ({ httpOnly: true, sameSite: 'strict' as const, secure: process.env.NODE_ENV === 'production', path: '/' });
function permittedOrigin(req: Request) {
  const origin = req.get('Origin');
  return !origin || origin === (process.env.CORS_ORIGIN ?? 'http://localhost:5173');
}

async function session(db: PrismaClient, req: Request) {
  const token = sessionToken(req);
  if (!token) return undefined;
  const stored = await db.staffSession.findUnique({ where: { tokenHash: digest(token) }, include: { user: true } });
  if (!stored?.user.active || stored.expiresAt <= new Date()) return undefined;
  const { id, username, displayName, role } = stored.user;
  return { id, username, displayName, role, permissions: permissions(role, stored.user.permissions), tokenHash: stored.tokenHash, branchOnly: stored.user.branchOnly };
}

function mayAccess(role: StaffRole, allowed: readonly string[], method: string, path: string) {
  if (role === 'ADMIN') return true;
  const has = (...pages: string[]) => pages.some(page => allowed.includes(page));
  const reading = method === 'GET' || method === 'HEAD';
  if (/^\/products(?:\/|$)/.test(path)) return has('Products') || (reading && has('Dashboard', 'Quick Sale'));
  if (/^\/categories(?:\/|$)/.test(path)) return has('Categories') || (reading && has('Products', 'Dashboard', 'Quick Sale'));
  if (/^\/inventory(?:\/|$)/.test(path)) return has('Inventory / Stock') || (reading && path === '/inventory/variants' && has('Purchases','Quick Sale','Sales & Distribution'));
  if (['/dashboard','/stock-alerts'].includes(path)) return has('Dashboard') || (path === '/stock-alerts' && has('Inventory / Stock'));
  if (/^\/purchase-orders(?:[/.]|$)/.test(path)) return has('Purchases');
  if (/^\/suppliers(?:\/|$)/.test(path)) return has('Customers / Suppliers','Purchases');
  if (/^\/customers(?:\/|$)/.test(path)) return has('Customers / Suppliers') || (reading && has('Quick Sale','Sales & Distribution','Payments','Returns'));
  if (path === '/sales-checkout') return has('Quick Sale');
  if (path.startsWith('/sales-invoices/')) return reading && has('Quick Sale','Sales & Distribution','Payments','Returns','Reports');
  if (/^\/sales-orders(?:\/|$)/.test(path)) {
    if (reading) return has('Sales & Distribution','Payments','Reports','Returns');
    if (path.endsWith('/returns') || path.endsWith('/settlements')) return has('Returns');
    if (path.endsWith('/payments')) return has('Payments');
    if (path.endsWith('/dispatches')) return has('Sales & Distribution') && role !== 'FINANCE';
    return has('Sales & Distribution') && role !== 'WAREHOUSE' && role !== 'FINANCE';
  }
  if (path === '/sales-dashboard') return has('Reports');
  if (path === '/day-look') return has('Day Look');
  return path === '/activity-logs' && has('Activity Logs');
}

export function requireStaff(db: PrismaClient): import('express').RequestHandler {
  return (req, res, next) => {
    if (req.path === '/health' || /^\/auth\/(login|logout|session|password|signup|reset-password)\/?$/.test(req.path) || testAuthBypass()) { next(); return; }
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && !permittedOrigin(req)) {
      next(new RequestError(403, 'Request origin is not allowed')); return;
    }
    session(db, req).then(async user => {
      if (!user) throw new RequestError(401, 'Sign in to continue');
      const path = req.path.replace(/\/$/, '');
      if (path === '/locations' || path.startsWith('/locations/')) {
        staffContext.run(user, next);
        return;
      }
      const id = res.locals.branchId as string | undefined;
      if (!id && user.branchOnly && user.role !== 'ADMIN') throw new RequestError(403, 'Select an assigned branch');
      if (!id) {
        if (!mayAccess(user.role, user.permissions, req.method, path)) throw new RequestError(403, 'Your role cannot access this operation');
        staffContext.run(user, next);
        return;
      }
      const branch = await db.branch.findFirst({
        where: { id, ready: true },
        include: { access: { where: { userId: user.id } } },
      });
      if (!branch || (user.role !== 'ADMIN' && !branch.access.length)) throw new RequestError(403, 'You do not have access to this branch');
      const allowed = user.role === 'ADMIN' ? modules : branch.access[0].permissions;
      if (!mayAccess(user.role, allowed, req.method, path)) throw new RequestError(403, 'Your role cannot access this operation');
      locationContext.run(branchClient(branch.schemaName), () => staffContext.run(user, next));
    }).catch(next);
  };
}

const attempts = new Map<string, { count: number; until: number }>();
function throttle(req: Request) {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
  const key = req.ip ?? 'unknown';
  const entry = attempts.get(key) ?? { until: now + 60_000, count: 0 };
  if (entry.count >= 12 || (attempts.size >= 10000 && !attempts.has(key))) throw new RequestError(429, 'Too many sign-in attempts. Try again in a minute.');
  entry.count++;
  attempts.set(key, entry);
}

async function ownAccount(db: PrismaClient, req: Request) {
  if (!permittedOrigin(req) && req.method !== 'GET') throw new RequestError(403, 'Request origin is not allowed');
  const user = await session(db, req);
  if (!user) throw new RequestError(401, 'Sign in to continue');
  return user;
}

const email = z.string().trim().max(254).email().transform(value => value.toLowerCase());
const login = z.object({ username: z.union([username, email]), password: z.string().min(1).max(128) }).strict();
const account = z.object({ username: z.union([username, email]), displayName: z.string().trim().min(2).max(100), role: z.nativeEnum(StaffRole), permissions: moduleInput, branchOnly: z.boolean().optional(), password }).strict();
const accountEdit = account.omit({ username: true }).partial().extend({
  active: z.boolean().optional(), approveSignup: z.literal(true).optional(),
}).strict();
const settings = z.object({
  companyName: z.string().trim().min(2).max(100), address: z.string().trim().max(300),
  email: z.union([z.literal(''), z.string().trim().max(240).email()]), phone: z.string().trim().max(40),
  invoiceFooter: z.string().trim().max(250),
  invoiceLogo: z.string().max(81000).refine(value => invoiceLogo(value) !== undefined, 'Upload a valid shop logo').nullable().optional(),
  invoiceLogoPlacement: z.enum(['HEADER','WATERMARK','BOTH']).optional(),
  invoiceTimeZone: z.string().trim().min(1).max(80).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Use a valid time zone, such as Asia/Karachi').optional(),
}).strict();

export function staffRoutes(db: PrismaClient, operations: PrismaClient = db) {
  const router = Router();
  router.post('/auth/signup', wrap(async (req, res) => {
    if (!permittedOrigin(req)) throw new RequestError(403, 'Request origin is not allowed');
    throttle(req);
    const input = account.pick({ displayName: true, password: true }).extend({ email }).parse(req.body);
    const passwordHash = await hashPassword(input.password);
    await db.staffUser.create({ data: {
      username: input.email, displayName: input.displayName, passwordHash,
      role: 'WAREHOUSE', active: false, permissions: [], signupPending: true,
    } });
    res.status(201).json({ message: 'Account created. Ask your administrator to approve access, then sign in.' });
  }));
  router.post('/auth/reset-password', wrap(async (req, res) => {
    if (!permittedOrigin(req)) throw new RequestError(403, 'Request origin is not allowed');
    throttle(req);
    const input = z.object({ code: z.string().trim().regex(/^[a-f0-9]{48}$/i), password }).strict().parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const resetHash = digest(input.code.toLowerCase());
    await db.$transaction(async tx => {
      const user = await tx.staffUser.findUnique({ where: { resetHash }, select: { id: true } });
      if (!user) throw new RequestError(400, 'Reset code is invalid or expired');
      const changed = await tx.staffUser.updateMany({
        where: { id: user.id, resetHash, resetExpires: { gt: new Date() }, active: true },
        data: { passwordHash, resetHash: null, resetExpires: null },
      });
      if (!changed.count) throw new RequestError(400, 'Reset code is invalid or expired');
      await tx.staffSession.deleteMany({ where: { userId: user.id } });
    });
    res.clearCookie(sessionName, cookie()).status(204).end();
  }));
  router.post('/auth/login', wrap(async (req, res) => {
    if (!permittedOrigin(req)) throw new RequestError(403, 'Request origin is not allowed');
    throttle(req);
    const credentials = login.safeParse(req.body);
    if (!credentials.success) throw new RequestError(400, 'Enter a valid username or email and your password');
    const input = credentials.data;
    const staff = await db.staffUser.findUnique({ where: { username: input.username } });
    if (!(await checkPassword(input.password, staff?.passwordHash))) throw new RequestError(401, 'Incorrect username, email, or password');
    if (!staff?.active) throw new RequestError(403, staff?.signupPending
      ? 'Account is awaiting administrator approval.'
      : 'Account is inactive. Contact your administrator.');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + maxAge);
    const current = sessionToken(req);
    const signedIn = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "StaffUser" WHERE id = ${staff.id} FOR UPDATE`;
      const latest = await tx.staffUser.findUniqueOrThrow({ where: { id: staff.id } });
      if (!latest.active || latest.passwordHash !== staff.passwordHash) throw new RequestError(401, 'Please sign in again');
      await tx.staffSession.deleteMany({ where: { OR: [{ expiresAt: { lte: new Date() } }, ...(current ? [{ tokenHash: digest(current) }] : [])] } });
      await tx.staffSession.create({ data: { tokenHash: digest(token), userId: staff.id, expiresAt } });
      return latest;
    });
    res.cookie(sessionName, token, { ...cookie(), maxAge });
    const { id, username, displayName, role } = signedIn;
    res.set('Cache-Control', 'no-store').json({ id, username, displayName, role, permissions: permissions(role, signedIn.permissions) });
  }));
  router.get('/auth/session', wrap(async (req, res) => {
    const { tokenHash, ...user } = await ownAccount(db, req);
    res.set('Cache-Control','no-store').json(user);
  }));
  router.post('/auth/logout', wrap(async (req, res) => {
    if (!permittedOrigin(req)) throw new RequestError(403, 'Request origin is not allowed');
    const token = sessionToken(req);
    if (token) await db.staffSession.deleteMany({ where: { tokenHash: digest(token) } });
    res.clearCookie(sessionName, cookie()).status(204).end();
  }));
  router.post('/auth/password', wrap(async (req, res) => {
    const user = await ownAccount(db, req);
    const input = z.object({ current: z.string().min(1).max(128), next: password }).strict().parse(req.body);
    const old = await db.staffUser.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await checkPassword(input.current, old.passwordHash))) throw new RequestError(400, 'Current password is incorrect');
    const passwordHash = await hashPassword(input.next);
    await staffContext.run(user, () => attributed(db, async tx => {
      const updated = await tx.staffUser.updateMany({ where: { id: user.id, passwordHash: old.passwordHash }, data: { passwordHash, resetHash: null, resetExpires: null } });
      if (!updated.count) throw new RequestError(409, 'Password changed. Sign in again.');
      await tx.staffSession.deleteMany({ where: { userId: user.id } });
    }));
    res.clearCookie(sessionName, cookie()).status(204).end();
  }));
  const admin = () => {
    const actor = staffContext.getStore();
    if (actor?.role !== 'ADMIN') throw new RequestError(403, 'Administrator access is required');
    return actor;
  };
  router.get('/settings/business', wrap(async (_req, res) => {
    res.json(await operations.businessSettings.findUnique({ where: { id: 'workspace' } }) ?? {
      id: 'workspace', companyName: 'GarmentPro', address: '', phone: '', email: '', invoiceFooter: '',
      invoiceLogo: null, invoiceLogoPlacement: 'HEADER', invoiceTimeZone: 'Asia/Karachi',
    });
  }));
  router.patch('/settings/business', wrap(async (req, res) => {
    admin();
    const data = settings.parse(req.body);
    res.json(await attributed(operations, tx => tx.businessSettings.upsert({ where: { id: 'workspace' }, create: { id: 'workspace', ...data }, update: data })));
  }));
  router.get('/settings/staff', wrap(async (_req, res) => {
    admin();
    const staff = await db.staffUser.findMany({ select: users, orderBy: { username: 'asc' } });
    res.json(staff.map(user => ({ ...user, permissions: permissions(user.role, user.permissions) })));
  }));
  router.get('/settings/signup-requests', wrap(async (_req, res) => {
    admin();
    const where = { signupPending: true, active: false };
    const [items, total] = await db.$transaction([
      db.staffUser.findMany({ where, select: { id: true, displayName: true, username: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25 }),
      db.staffUser.count({ where }),
    ]);
    res.set('Cache-Control', 'no-store').json({ items, total });
  }));
  router.post('/settings/signup-requests/:id/cancel', wrap(async (req, res) => {
    admin();
    const cancelled = await attributed(db, tx => tx.staffUser.updateMany({
      where: { id: req.params.id, signupPending: true, active: false },
      data: { signupPending: false },
    }));
    if (!cancelled.count) throw new RequestError(409, 'This request has already been handled');
    res.status(204).end();
  }));
  router.post('/settings/staff', wrap(async (req, res) => {
    admin();
    const { password: secret, ...data } = account.parse(req.body);
    const passwordHash = await hashPassword(secret);
    res.status(201).json(await attributed(db, tx => tx.staffUser.create({ data: { ...data, passwordHash }, select: users })));
  }));
  router.post('/settings/staff/:id/reset-code', wrap(async (req, res) => {
    admin();
    const code = randomBytes(24).toString('hex');
    const resetExpires = new Date(Date.now() + 15 * 60 * 1000);
    const updated = await attributed(db, tx => tx.staffUser.updateMany({
      where: { id: req.params.id, active: true },
      data: { resetHash: digest(code), resetExpires },
    }));
    if (!updated.count) throw new RequestError(404, 'Active staff account not found');
    res.set('Cache-Control', 'no-store').json({ code });
  }));
  router.patch('/settings/staff/:id', wrap(async (req, res) => {
    const actor = admin();
    const { password: secret, approveSignup, ...data } = accountEdit.parse(req.body);
    if (approveSignup && data.active !== true) throw new RequestError(400, 'Activate the account to approve this request');
    if (actor.id === req.params.id && (data.active === false || (data.role && data.role !== 'ADMIN'))) {
      throw new RequestError(400, 'You cannot disable or demote your current administrator account');
    }
    const passwordHash = secret ? await hashPassword(secret) : undefined;
    res.json(await attributed(db, async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(848327)`;
      const current = await tx.staffUser.findUnique({ where: { id: actor.id } });
      if (!current?.active || current.role !== 'ADMIN') throw new RequestError(403, 'Administrator access is required');
      await tx.$queryRaw`SELECT id FROM "StaffUser" WHERE id = ${req.params.id} FOR UPDATE`;
      if (approveSignup && !await tx.staffUser.findFirst({ where: { id: req.params.id, signupPending: true, active: false }, select: { id: true } })) {
        throw new RequestError(409, 'This request has already been handled');
      }
      if (data.active === false || (data.role && data.role !== 'ADMIN')) {
        const target = await tx.staffUser.findUniqueOrThrow({ where: { id: req.params.id } });
        if (target.active && target.role === 'ADMIN' && await tx.staffUser.count({ where: { role: 'ADMIN', active: true } }) < 2) {
          throw new RequestError(409, 'Keep at least one active administrator');
        }
      }
      const revokeReset = data.active === false || passwordHash;
      const user = await tx.staffUser.update({ where: { id: req.params.id }, data: {
        ...data, passwordHash, ...(data.active === true ? { signupPending: false } : {}),
        ...(revokeReset ? { resetHash: null, resetExpires: null } : {}),
      }, select: users });
      if (data.active === false || data.role || data.permissions || data.branchOnly !== undefined || passwordHash) await tx.staffSession.deleteMany({ where: { userId: user.id } });
      return user;
    }));
  }));
  return router;
}
