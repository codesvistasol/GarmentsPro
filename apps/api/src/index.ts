import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { salesRoutes } from './sales.js';
import { dateBounds, dateFilters } from './date-filters.js';
import { productImage } from './product-image.js';
import { inactiveCategoryIds } from './catalogue-visibility.js';
import { groupImportRows, importRows } from './catalogue-import.js';
import { activityRoutes } from './activity.js';
import { requireStaff, staffRoutes } from './staff.js';
import { attributed } from './staff-context.js';
import { recordMovement, RequestError, warehouseRoutes, wrap } from './warehouse.js';
import { locationRoutes, operationalClient } from './locations.js';
const app = express();
const central = new PrismaClient();
const db = operationalClient(central);
app.use((req, res, next) => {
  const branch = /^\/api\/branch\/([a-z0-9]{1,50})(?=\/)/.exec(req.url);
  if (branch) {
    res.locals.branchId = branch[1];
    req.url = '/api' + req.url.slice(branch[0].length);
  }
  next();
});
app.use(cors({origin:process.env.CORS_ORIGIN ?? 'http://localhost:5173', credentials: true}));
app.use('/api/products/import', express.json({limit:'1mb'}));
app.use(express.json({limit:'100kb'}));
const categoryInput=z.object({name:z.string().trim().min(2).max(80),parentId:z.string().nullable().optional(),active:z.boolean().optional()});
const productInput=z.object({sku:z.string().trim().min(2).max(40),name:z.string().trim().min(2).max(120),description:z.string().max(1000).optional().nullable(),categoryId:z.string().min(1),costPrice:z.coerce.number().min(0),salePrice:z.coerce.number().min(0),active:z.boolean().optional(),image:productImage,variants:z.array(z.object({sku:z.string().trim().min(2),size:z.string().trim().min(1),color:z.string().trim().min(1),availableQty:z.coerce.number().int().min(0).max(2147483647),reorderPoint:z.coerce.number().int().min(0).max(2147483647).default(5)})).min(1)});
const productInclude = { category: true, variants: true, image: { select: { productId: true } } } satisfies Prisma.ProductInclude;
const categoryCount = { _count: { select: { products: true, children: true } } } as const;

async function createProduct(tx: Prisma.TransactionClient, { variants, image, ...data }: z.infer<typeof productInput>, reason: string) {
  const created = await tx.product.create({
    data: { ...data, image: image ? { create: image } : undefined,
      variants: { create: variants.map(({ availableQty, ...variant }) => variant) } },
    include: productInclude,
  });
  const amounts = new Map(variants.map(variant => [variant.sku, variant.availableQty]));
  for (const variant of created.variants) {
    const quantity = amounts.get(variant.sku) ?? 0;
    if (quantity) variant.availableQty = (await recordMovement(tx, { variantId: variant.id, type: 'OPENING', quantity, reason })).balanceAfter;
  }
  return created;
}
app.use('/api', requireStaff(central));
app.use('/api', locationRoutes(central));
app.use('/api', staffRoutes(central, db));
app.use('/api', warehouseRoutes(db));
app.use('/api', salesRoutes(db));
app.use('/api', activityRoutes(db));
app.get('/api/health', async (_req, res) => {
  try {
    await db.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: 'garmentpro-api', database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, service: 'garmentpro-api', database: 'unavailable' });
  }
});
app.get('/api/categories', wrap(async (_req, res) =>
  res.json(await db.category.findMany({ orderBy: { name: 'asc' }, include: categoryCount }))));
app.post('/api/categories',wrap(async(req,res)=>{const data=categoryInput.parse(req.body); const category=await attributed(db, tx => tx.category.create({data}));res.status(201).json(category)}));
app.patch('/api/categories/:id', wrap(async (req, res) => {
  const data = categoryInput.partial().parse(req.body);
  const id = req.params.id;
  const category = await attributed(db, async tx => {
    if (data.parentId) {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(728214)`;
      const rows = await tx.category.findMany({ select: { id: true, parentId: true } });
      const parents = new Map(rows.map(row => [row.id, row.parentId]));
      const visited = new Set([id]);
      let parent: string | null | undefined = data.parentId;
      while (parent) {
        if (visited.has(parent)) throw new RequestError(400, 'A category cannot be moved below itself');
        visited.add(parent);
        parent = parents.get(parent);
      }
    }
    return tx.category.update({ where: { id }, data, include: categoryCount });
  });
  res.json(category);
}));
app.delete('/api/categories/:id',wrap(async(req,res)=>{const c=await db.category.findUnique({where:{id:req.params.id},include:{_count:{select:{products:true,children:true}}}});if(!c)return res.status(404).json({error:'Not found'});if(c._count.products||c._count.children)return res.status(409).json({error:'Move products/subcategories before deleting'});await attributed(db, tx => tx.category.delete({where:{id:c.id}}));res.status(204).end()}));
app.get('/api/products', wrap(async (req, res) => {
  const search = String(req.query.search ?? '').trim().slice(0, 100);
  const page = z.coerce.number().int().min(1).max(100000).optional().parse(req.query.page);
  const sort = z.enum(['newest', 'name', 'sku', 'serial', 'price', 'photo']).default('newest').parse(req.query.sort);
  const categoryId = z.string().max(100).optional().parse(req.query.categoryId);
  const status = z.enum(['active','inactive','all','out']).default('active').parse(req.query.status);
  const inactive = await inactiveCategoryIds(db);
  const inactiveSet = new Set(inactive);
  const includeChildren = req.query.includeChildren === 'true';
  const serial = /^\d{1,9}$/.test(search) ? Number(search) : undefined;
  const match = { contains: search, mode: 'insensitive' as const };
  const where: Prisma.ProductWhereInput = {
    archived: false,
    ...(status === 'active' || status === 'out' ? { active: true } : {}),
    ...(categoryId && (includeChildren
      ? { AND: [{ OR: [{ categoryId }, { category: { parentId: categoryId } }] }] }
      : { categoryId })),
    createdAt: dateBounds(dateFilters.parse(req.query)),
    OR: serial !== undefined
      ? [{ serialNumber: serial }, { sku: { equals: search, mode: 'insensitive' } }]
      : search ? [{ name: match }, { sku: match }, { category: { name: match } }] : undefined,
  };
  const scope = Array.isArray(where.AND) ? where.AND : [];
  if (status === 'active' || status === 'out') scope.push({ categoryId: { notIn: inactive } });
  if (status === 'inactive') scope.push({ OR: [{ active: false }, { categoryId: { in: inactive } }] });
  if (status === 'out') scope.push({ variants: { some: {}, every: { availableQty: 0 } } });
  if (scope.length) where.AND = scope;
  const sortOrder: Record<typeof sort, Prisma.ProductOrderByWithRelationInput[]> = {
    newest: [{ createdAt: 'desc' }], name: [{ name: 'asc' }], sku: [{ sku: 'asc' }],
    serial: [{ category: { name: 'asc' } }, { serialNumber: 'asc' }], price: [{ salePrice: 'asc' }],
    photo: [{ image: { productId: 'asc' } }, { createdAt: 'desc' }],
  };
  const result = db.product.findMany({
    where, include: productInclude,
    orderBy: [...sortOrder[sort], { id: 'asc' }],
    skip: page ? (page - 1) * 25 : 0,
    take: page ? 25 : 200,
  });
  const [rows, total] = page
    ? await db.$transaction([result, db.product.count({ where })], { isolationLevel: 'RepeatableRead' })
    : [await result, undefined];
  const items = rows.map(product => ({
    ...product, costPrice: product.costPrice.toString(), salePrice: product.salePrice.toString(),
    saleActive: product.active && !inactiveSet.has(product.categoryId),
    totalQty: product.variants.reduce((sum, variant) => sum + variant.availableQty, 0),
  }));
  res.json(page ? { items, total, page } : items);
}));
app.post('/api/products', wrap(async (req, res) => {
  const data = productInput.parse(req.body);
  const product = await attributed(db, tx => createProduct(tx, data, 'Product opening balance'));
  res.status(201).json(product);
}));
app.post('/api/products/import', wrap(async (req, res) => {
  const groups = groupImportRows(importRows.parse(req.body).rows);
  const result = await attributed(db, async tx => {
    const skus = groups.map(group => group.row.sku);
    const variantSkus = groups.flatMap(group => group.variants.map(variant => variant.variantSku));
    const product = await tx.product.findFirst({ where: { sku: { in: skus, mode: 'insensitive' } }, select: { sku: true } });
    const variant = await tx.variant.findFirst({ where: { sku: { in: variantSkus, mode: 'insensitive' } }, select: { sku: true } });
    if (product || variant) throw new RequestError(409, 'Import contains an existing SKU: ' + (product?.sku ?? variant?.sku));
    const categories = new Map((await tx.category.findMany()).map(category => [category.name.toLowerCase(), category]));
    async function category(name: string, parentId: string | null) {
      const key = name.toLowerCase();
      const found = categories.get(key);
      if (found) {
        if (found.parentId !== parentId) throw new RequestError(409, 'Category already exists under a different parent: ' + name);
        return found;
      }
      const created = await tx.category.create({ data: { name, parentId } });
      categories.set(key, created);
      return created;
    }
    for (const { row, variants } of groups) {
      const parent = await category(row.category, null);
      const selected = row.subcategory ? await category(row.subcategory, parent.id) : parent;
      await createProduct(tx, productInput.parse({
        sku: row.sku, name: row.name, description: row.description, categoryId: selected.id,
        costPrice: row.costPrice, salePrice: row.salePrice, active: row.active,
        variants: variants.map(variant => ({ ...variant, sku: variant.variantSku })),
      }), 'Spreadsheet opening balance');
    }
    return { products: groups.length, variants: variantSkus.length };
  }, { timeout: 30000 });
  res.status(201).json(result);
}));
app.get('/api/stock-alerts', wrap(async (_req, res) => {
  const items = await db.product.findMany({
    where: { archived: false, active: true, categoryId: { notIn: await inactiveCategoryIds(db) },
      variants: { some: {}, every: { availableQty: 0 } } },
    select: { id: true, name: true, sku: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  res.json(items);
}));
app.get('/api/products/:id/image', wrap(async (req, res) => {
  const image = await db.productImage.findUniqueOrThrow({ where: { productId: req.params.id } });
  res.set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-cache')
    .type(image.mimeType).send(Buffer.from(image.content));
}));
app.patch('/api/products/:id', wrap(async (req, res) => {
  const { image, ...data } = productInput.omit({ variants: true }).partial().parse(req.body);
  const id = req.params.id;
  const product = await attributed(db, async tx => {
    await tx.product.update({ where: { id }, data });
    if (image === null) await tx.productImage.deleteMany({ where: { productId: id } });
    if (image) await tx.productImage.upsert({ where: { productId: id }, create: { productId: id, ...image }, update: image });
    return tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });
  });
  res.json(product);
}));
app.delete('/api/products/:id', wrap(async (req, res) => {
  const id = req.params.id;
  await attributed(db, async tx => {
    if (req.query.emptyOnly === 'true') {
      await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${id} FOR UPDATE`;
      const variants = await tx.$queryRaw<{ availableQty: number }[]>`
        SELECT "availableQty" FROM "Variant" WHERE "productId" = ${id} ORDER BY id FOR UPDATE
      `;
      if (variants.some(variant => variant.availableQty > 0)) {
        throw new RequestError(409, 'This product still has stock. Deactivate it to stop new sales.');
      }
    }
    await tx.product.update({ where: { id }, data: { archived: true } });
  });
  res.status(204).end();
}));
app.get('/api/dashboard',wrap(async(_req,res)=>{const products=await db.product.findMany({where:{archived:false},include:{category:true,variants:true}});const units=products.reduce((n,p)=>n+p.variants.reduce((s,v)=>s+v.availableQty,0),0);const low=products.flatMap(p=>p.variants.filter(v=>v.availableQty<=v.reorderPoint).map(v=>({sku:v.sku,name:p.name,availableQty:v.availableQty})));const byCategory=Object.entries(products.reduce<Record<string,number>>((a,p)=>{a[p.category.name]=(a[p.category.name]??0)+p.variants.reduce((s,v)=>s+v.availableQty,0);return a},Object.create(null))).map(([name,qty])=>({name,qty}));res.json({products:products.length,availableUnits:units,lowStock:low,byCategory,inventoryCost:products.reduce((n,p)=>n+Number(p.costPrice)*p.variants.reduce((s,v)=>s+v.availableQty,0),0)})}));
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(err instanceof RequestError)return res.status(err.status).json({error:err.message});if(err instanceof z.ZodError)return res.status(400).json({error:'Validation error',details:err.flatten()});if(err instanceof Prisma.PrismaClientKnownRequestError){if(err.code==='P2002')return res.status(409).json({error:'A record with that SKU, name, reference, or request key already exists'});if(err.code==='P2003')return res.status(409).json({error:'A related record is missing or still in use'});if(err.code==='P2025')return res.status(404).json({error:'Record not found'});}console.error(err);res.status(500).json({error:'Internal server error'})});
export { app, central as db };
