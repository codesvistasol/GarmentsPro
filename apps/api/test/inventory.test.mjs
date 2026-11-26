import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

const databaseUrl = process.env.GARMENTPRO_TEST_DATABASE_URL;
assert.ok(databaseUrl, 'Set GARMENTPRO_TEST_DATABASE_URL to a migrated, disposable PostgreSQL database');
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.GARMENTPRO_TEST_ALLOW_UNAUTHENTICATED = '1';
const { app, db } = await import('../dist/index.js');
const suffix = randomUUID().slice(0, 12);
let server;
let base;
let category;
let supplier;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
  category = await expected('/categories', 201, 'POST', { name: 'Test category ' + suffix });
  supplier = await expected('/suppliers', 201, 'POST', { company: 'Test supplier ' + suffix, active: true });
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db.$disconnect();
});

async function call(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}

async function expected(path, status, method, body) {
  const result = await call(path, method, body);
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}

async function product(opening = 0) {
  const sku = 'TEST-' + randomUUID().slice(0, 24);
  return expected('/products', 201, 'POST', {
    sku, name: 'Test shirt', categoryId: category.id, costPrice: 12.5, salePrice: 20,
    variants: [
      { sku: sku + '-S', size: 'S', color: 'Blue', availableQty: opening },
      { sku: sku + '-L', size: 'L', color: 'Black', availableQty: 0 },
    ],
  });
}

function reference(prefix) {
  return prefix + '-' + randomUUID();
}

async function order(items, supplierId = supplier.id) {
  return expected('/purchase-orders', 201, 'POST', {
    supplierId, reference: reference('PO'), orderDate: '2026-01-15', items,
  });
}

function receive(orderId, lines, status = 201, receiptRef = reference('GR')) {
  return expected('/purchase-orders/' + orderId + '/receipts', status, 'POST', { reference: receiptRef, lines });
}

function move(variantId, type, quantity, extra = {}) {
  return call('/inventory/movements', 'POST', {
    variantId, type, quantity, reason: 'Stock integration test',
    destination: 'Test location', reference: reference('MOV'), requestKey: randomUUID(), ...extra,
  });
}

async function balance(variantId) {
  return (await db.variant.findUniqueOrThrow({ where: { id: variantId } })).availableQty;
}

async function ledger(variantId) {
  const history = await expected('/inventory/history?variantId=' + variantId, 200);
  return history.items;
}

test('Phase 1 catalogue, category edits, search, dashboard and archive still use database records', async () => {
  await expected('/health', 200);
  const renamed = 'Renamed category ' + suffix;
  await expected('/categories/' + category.id, 200, 'PATCH', { name: renamed });
  const before = await expected('/dashboard', 200);
  const item = await product(4);
  const variant = item.variants.find(variant => variant.size === 'S');
  assert.equal(variant.availableQty, 4);
  assert.deepEqual((await ledger(variant.id)).map(row => [row.type, row.quantity, row.balanceAfter]), [['OPENING', 4, 4]]);
  await expected('/products/' + item.id, 200, 'PATCH', { name: 'Edited shirt ' + suffix });
  const found = await expected('/products?search=' + item.sku.toLowerCase(), 200);
  assert.equal(found[0].name, 'Edited shirt ' + suffix);
  assert.equal(found[0].category.name, renamed);
  const after = await expected('/dashboard', 200);
  assert.equal(after.availableUnits, before.availableUnits + 4);
  assert.equal(after.inventoryCost, before.inventoryCost + 50);
  assert.ok(after.lowStock.some(row => row.sku === variant.sku));
  await expected('/products/' + item.id, 204, 'DELETE');
  assert.deepEqual(await expected('/products?search=' + item.sku, 200), []);
  assert.equal((await expected('/dashboard', 200)).availableUnits, before.availableUnits);
  assert.equal(await balance(variant.id), 4);
});

test('full receipt puts stock on the exact variants and preserves order labels after edits', async () => {
  const { id, variants } = await product();
  const [first, second] = variants;
  const purchase = await order([
    { variantId: first.id, quantity: 6, unitPrice: '11.25' },
    { variantId: second.id, quantity: 4, unitPrice: '12.01' },
  ]);
  await expected('/products/' + id, 200, 'PATCH', { name: 'Name changed after ordering' });
  const reference = purchase.reference + '-receipt';
  const receipt = await receive(purchase.id, purchase.items.map(item => ({ itemId: item.id, quantity: item.quantity })), 201, reference);
  assert.equal(receipt.lines.length, 2);
  const stored = await expected('/purchase-orders/' + purchase.id, 200);
  assert.ok(stored.items.every(item => item.quantity === item.receivedQty && item.productName === 'Test shirt'));
  assert.deepEqual(await Promise.all([balance(first.id), balance(second.id)]), [6, 4]);
  for (const item of stored.items) {
    const rows = await ledger(item.variantId);
    assert.deepEqual(rows.map(row => [row.type, row.quantity, row.reference]), [['RECEIPT', item.quantity, reference]]);
  }
});

test('partial receipt, duplicate reference and over-receipt preserve stock and receipt history', async () => {
  const { variants: [variant, other] } = await product();
  const purchase = await order([
    { variantId: variant.id, quantity: 8, unitPrice: '7' },
    { variantId: other.id, quantity: 4, unitPrice: '7' },
  ]);
  const item = purchase.items.find(item => item.variantId === variant.id);
  const otherItem = purchase.items.find(item => item.variantId === other.id);
  const receiptRef = reference('partial');
  await receive(purchase.id, [{ itemId: item.id, quantity: 3 }], 201, receiptRef);
  assert.equal(await balance(variant.id), 3);
  await receive(purchase.id, [{ itemId: item.id, quantity: 2 }], 409, receiptRef);
  await receive(purchase.id, [{ itemId: otherItem.id, quantity: 2 }, { itemId: item.id, quantity: 6 }], 409);
  assert.equal(await balance(other.id), 0);
  assert.equal(await balance(variant.id), 3);
  await receive(purchase.id, [{ itemId: item.id, quantity: 5 }]);
  const stored = await expected('/purchase-orders/' + purchase.id, 200);
  assert.equal(stored.receipts.length, 2);
  assert.equal(stored.items.find(line => line.id === item.id).receivedQty, 8);
  assert.equal(await balance(variant.id), 8);
  assert.equal((await ledger(variant.id)).length, 2);
});

test('stock out validates destination and rejects an overdraft without a ledger entry', async () => {
  const { variants: [variant] } = await product(9);
  assert.equal((await move(variant.id, 'STOCK_OUT', 1, { destination: undefined })).status, 400);
  assert.equal((await move(variant.id, 'STOCK_OUT', 10)).status, 409);
  const out = await move(variant.id, 'STOCK_OUT', 4);
  assert.equal(out.status, 201);
  assert.equal(out.body.quantity, -4);
  assert.equal(out.body.balanceAfter, 5);
  assert.equal(out.body.destination, 'Test location');
  assert.equal(await balance(variant.id), 5);
  assert.equal((await ledger(variant.id)).length, 2);
});

test('returns, damage and signed adjustments produce immutable movements', async () => {
  const { variants: [variant] } = await product();
  for (const [type, quantity, delta, expectedBalance] of [
    ['STOCK_IN', 10, 10, 10], ['RETURN_IN', 4, 4, 14], ['RETURN_TO_SUPPLIER', 3, -3, 11],
    ['DAMAGE', 2, -2, 9], ['ADJUSTMENT', -4, -4, 5], ['ADJUSTMENT', 1, 1, 6],
  ]) {
    const response = await move(variant.id, type, quantity);
    assert.equal(response.status, 201);
    assert.equal(response.body.quantity, delta);
    assert.equal(response.body.balanceAfter, expectedBalance);
  }
  assert.equal(await balance(variant.id), 6);
  const rows = await ledger(variant.id);
  await assert.rejects(db.stockMovement.delete({ where: { id: rows[0].id } }), /immutable/);
  await assert.rejects(db.stockMovement.update({ where: { id: rows[0].id }, data: { reason: 'Changed' } }), /immutable/);
  await assert.rejects(db.variant.update({ where: { id: variant.id }, data: { availableQty: 99 } }), /stock ledger/);
  const ignored = await db.$executeRaw`
    INSERT INTO "StockMovement" ("id", "variantId", "type", "quantity", "balanceAfter")
    VALUES (${rows[0].id}, ${variant.id}, 'STOCK_IN', 1, 7)
    ON CONFLICT ("id") DO NOTHING
  `;
  assert.equal(ignored, 0);
  assert.equal(await balance(variant.id), 6);
  assert.equal((await ledger(variant.id)).length, 6);
});

test('concurrent stock changes serialize, prevent overdraft and deduplicate retries', async () => {
  const { variants: [variant] } = await product(10);
  const outgoing = await Promise.all([move(variant.id, 'STOCK_OUT', 7), move(variant.id, 'STOCK_OUT', 7)]);
  assert.deepEqual(outgoing.map(response => response.status).sort(), [201, 409]);
  const requestKey = randomUUID();
  const incoming = await Promise.all([
    move(variant.id, 'STOCK_IN', 2), move(variant.id, 'STOCK_IN', 3),
    move(variant.id, 'STOCK_IN', 4, { requestKey }), move(variant.id, 'STOCK_IN', 4, { requestKey }),
  ]);
  assert.deepEqual(incoming.map(response => response.status).sort(), [201, 201, 201, 409]);
  assert.equal(await balance(variant.id), 12);
  assert.equal((await ledger(variant.id)).reduce((sum, row) => sum + row.quantity, 0), 12);
});

test('concurrent purchase receipts cannot receive the same outstanding stock twice', async () => {
  const { variants: [variant] } = await product();
  const purchase = await order([{ variantId: variant.id, quantity: 5, unitPrice: '10' }]);
  const lines = [{ itemId: purchase.items[0].id, quantity: 4 }];
  const results = await Promise.all([1, 2].map(() => call('/purchase-orders/' + purchase.id + '/receipts', 'POST', {
    reference: reference('concurrent'), lines,
  })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(await balance(variant.id), 4);
  assert.equal((await ledger(variant.id)).length, 1);
  assert.equal((await expected('/purchase-orders/' + purchase.id, 200)).receipts.length, 1);
});

test('supplier search, deactivation, thresholds, history filters and CSV', async () => {
  const updated = await expected('/suppliers/' + supplier.id, 200, 'PATCH', {
    contactName: 'Purchasing test ' + suffix, email: 'purchasing@example.com', phone: '555-0100', address: 'Test Street', taxNumber: suffix,
  });
  const results = await expected('/suppliers?search=' + encodeURIComponent(updated.contactName.toUpperCase()), 200);
  assert.equal(results[0].id, supplier.id);
  const item = await product();
  const added = await expected('/inventory/variants', 201, 'POST', { productId: item.id, sku: item.sku + '-XL', size: 'XL', color: 'Red' });
  const { id } = added;
  await expected('/inventory/variants/' + id, 200, 'PATCH', { reorderPoint: 2 });
  await expected('/inventory/variants/' + id, 400, 'PATCH', { reorderPoint: 2, availableQty: 99 });
  assert.equal((await move(id, 'STOCK_IN', 3)).status, 201);
  assert.ok(!(await expected('/dashboard', 200)).lowStock.some(row => row.sku === added.sku));
  assert.equal((await move(id, 'STOCK_OUT', 1, { reason: '=2+3' })).status, 201);
  assert.ok((await expected('/dashboard', 200)).lowStock.some(row => row.sku === added.sku));
  const today = new Date().toISOString().slice(0, 10);
  const filter = `?productId=${item.id}&variantId=${id}&type=STOCK_OUT&from=${today}&to=${today}`;
  const found = await expected('/inventory/history' + filter, 200);
  assert.equal(found.total, 1);
  assert.equal(found.items[0].quantity, -1);
  const csv = await fetch(base + '/inventory/history.csv' + filter);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /inventory-history\.csv/);
  const content = await csv.text();
  assert.match(content, /"STOCK_OUT","-1","2","'=2\+3"/);
  assert.doesNotMatch(content, /STOCK_IN/);
  const purchase = await order([{ variantId: id, quantity: 1, unitPrice: '0.99' }]);
  const orderCsv = await fetch(base + '/purchase-orders.csv');
  assert.equal(orderCsv.status, 200);
  assert.match(orderCsv.headers.get('content-disposition'), /purchase-orders\.csv/);
  assert.ok((await orderCsv.text()).split('\r\n').some(row => row.includes(purchase.reference) && row.endsWith('"1","0","1","0.99"')));
  await expected('/suppliers/' + supplier.id, 204, 'DELETE');
  assert.equal((await expected('/suppliers/' + supplier.id, 200)).active, false);
  assert.equal((await expected('/purchase-orders/' + purchase.id, 200)).supplierName, supplier.company);
  await expected('/purchase-orders', 409, 'POST', {
    supplierId: supplier.id, reference: reference('inactive'), orderDate: today,
    items: [{ variantId: id, quantity: 1, unitPrice: '5' }],
  });
});

test('product catalogue paginates and finds rows beyond the legacy list limit', async () => {
  const skuPrefix = 'PAGE-' + randomUUID().slice(0, 12) + '-';
  const fixtures = Array.from({ length: 205 }, (_, index) => {
    const code = String(index).padStart(3, '0');
    return { sku: skuPrefix + code, categoryId: category.id, name: 'Catalogue row ' + code, salePrice: 1, costPrice: 0 };
  });
  await db.product.createMany({ data: fixtures });
  const first = await expected('/products?page=1&sort=sku&search=' + skuPrefix.toLowerCase(), 200);
  const last = await expected('/products?page=9&sort=sku&search=' + skuPrefix, 200);
  assert.equal(first.total, 205);
  assert.equal(first.items.length, 25);
  assert.equal(first.items[0].sku, fixtures[0].sku);
  assert.deepEqual(last.items.map(item => item.sku), fixtures.slice(200).map(item => item.sku));
  assert.equal((await expected('/products?search=' + skuPrefix, 200)).length, 200);
  assert.equal((await expected('/products?page=1&search=' + fixtures[204].sku.toLowerCase(), 200)).total, 1);
});

test('category serials are unique under concurrent creation and photos survive a catalogue reload', async () => {
  const first = await expected('/categories', 201, 'POST', { name: 'Photo category ' + randomUUID() });
  const second = await expected('/categories', 201, 'POST', { name: 'Other photo category ' + randomUUID() });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP5EAAAAASUVORK5CYII=';
  function payload(categoryId, image) {
    const sku = 'PHOTO-' + randomUUID().slice(0, 20);
    return {
      name: 'Photo shirt', sku, categoryId, costPrice: 8.25, salePrice: 12.45, image,
      variants: [{ sku: sku + '-M', color: 'Black', size: 'M', availableQty: 0 }],
    };
  }
  await expected('/products', 400, 'POST', payload(first.id, 'data:image/png;base64,SGVsbG8='));
  const [a, b, another] = await Promise.all([
    expected('/products', 201, 'POST', payload(first.id, 'data:image/png;base64,' + png)),
    expected('/products', 201, 'POST', payload(first.id)),
    expected('/products', 201, 'POST', payload(second.id)),
  ]);
  assert.deepEqual([a.serialNumber, b.serialNumber].sort(), [1, 2]);
  assert.equal(another.serialNumber, 1);
  assert.equal(a.salePrice, '12.45');
  const photo = await fetch(base + '/products/' + a.id + '/image');
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await photo.arrayBuffer()).toString('base64'), png);
  const today = new Date().toISOString().slice(0, 10);
  const result = await expected('/products?page=1&sort=serial&categoryId=' + first.id + '&from=' + today + '&to=' + today, 200);
  assert.deepEqual(result.items.map(item => item.serialNumber), [1, 2]);
  assert.deepEqual(result.items.find(item => item.id === a.id).image, { productId: a.id });
  const filtered = await expected('/products?page=1&categoryId=' + first.id + '&search=' + a.serialNumber, 200);
  assert.deepEqual(filtered.items.map(item => item.id), [a.id]);
  await expected('/products?page=1&from=2026-12-01&to=2026-01-01', 400);
  const moved = await expected('/products/' + a.id, 200, 'PATCH', { categoryId: second.id });
  assert.equal(moved.serialNumber, 2);
  await expected('/products/' + a.id, 200, 'PATCH', { image: null });
  await expected('/products/' + a.id + '/image', 404);
  await expected('/products/' + b.id, 204, 'DELETE');
  const afterArchive = await expected('/products', 201, 'POST', payload(first.id));
  assert.equal(afterArchive.serialNumber, 3);
});

test('parent catalogue filtering includes its immediate subcategory products', async () => {
  const root = await expected('/categories', 201, 'POST', { name: 'Main group ' + randomUUID() });
  const child = await expected('/categories', 201, 'POST', { name: 'Subgroup ' + randomUUID(), parentId: root.id });
  const sku = 'TREE-' + randomUUID().slice(0, 20);
  const item = await expected('/products', 201, 'POST', {
    name: 'Subcategory shirt', sku, categoryId: child.id, costPrice: 5, salePrice: 9,
    variants: [{ sku: sku + '-M', size: 'M', color: 'Blue', availableQty: 0 }],
  });
  const response = await expected('/products?page=1&includeChildren=true&categoryId=' + root.id, 200);
  assert.deepEqual(response.items.map(row => row.id), [item.id]);
  const exact = await expected('/products?page=1&categoryId=' + root.id, 200);
  assert.deepEqual(exact.items, []);
});

test('spreadsheet bulk import groups variants, records opening stock and rejects an atomic conflict', async () => {
  const tag = randomUUID().slice(0, 10);
  const root = 'Imported ' + tag;
  const child = 'Imported shelf ' + tag;
  const row = { sku: 'IMP-' + tag, name: 'Imported tee', category: root, subcategory: child,
    costPrice: '10.50', salePrice: '15.75', variantSku: 'IMPV-' + tag, size: 'S', color: 'Red', availableQty: 4 };
  const rows = [row, { ...row, size: 'M', variantSku: row.variantSku + '-M', availableQty: 6 }];
  assert.deepEqual(await expected('/products/import', 201, 'POST', { rows }), { products: 1, variants: 2 });
  const result = await expected('/products?search=' + row.sku, 200);
  assert.equal(result[0].totalQty, 10);
  assert.equal(result[0].category.name, child);
  const history = await expected('/inventory/history?productId=' + result[0].id, 200);
  assert.deepEqual(history.items.map(item => [item.type, item.quantity]).sort(), [['OPENING', 4], ['OPENING', 6]]);
  const fresh = { ...row, sku: row.sku + '-FRESH', variantSku: row.variantSku + '-FRESH', category: root + ' new', subcategory: undefined };
  await expected('/products/import', 409, 'POST', { rows: [fresh, row] });
  assert.deepEqual(await expected('/products?search=' + fresh.sku, 200), []);
  assert.ok(!(await expected('/categories', 200)).some(item => item.name === fresh.category));
});

test('zero stock alerts, safe deletion and product/category activation use the real stock state', async () => {
  const tag = randomUUID().slice(0, 10);
  const parent = await expected('/categories', 201, 'POST', { name: 'Status family ' + tag });
  const child = await expected('/categories', 201, 'POST', { name: 'Status shelf ' + tag, parentId: parent.id });
  const sku = 'STATUS-' + tag;
  const product = await expected('/products', 201, 'POST', { sku, name: 'Status shirt', categoryId: child.id,
    costPrice: 5, salePrice: 9, variants: [{ sku: sku + '-M', size: 'M', color: 'Blue', availableQty: 1 }] });
  await expected('/products/' + product.id + '?emptyOnly=true', 409, 'DELETE');
  await expected('/categories/' + parent.id, 400, 'PATCH', { parentId: child.id });
  await expected('/categories/' + parent.id, 200, 'PATCH', { active: false });
  assert.deepEqual(await expected('/products?search=' + sku, 200), []);
  let inactive = await expected('/products?status=inactive&search=' + sku, 200);
  assert.equal(inactive[0].saleActive, false);
  await expected('/categories/' + parent.id, 200, 'PATCH', { active: true });
  await expected('/products/' + product.id, 200, 'PATCH', { active: false });
  inactive = await expected('/products?status=inactive&search=' + sku, 200);
  assert.equal(inactive[0].active, false);
  await expected('/products/' + product.id, 200, 'PATCH', { active: true });
  const variantId = product.variants[0].id;
  await expected('/inventory/movements', 201, 'POST', {
    variantId, type: 'DAMAGE', quantity: 1, reason: 'Testing alert transition', reference: sku, requestKey: randomUUID(),
  });
  assert.ok((await expected('/stock-alerts', 200)).some(item => item.id === product.id));
  assert.equal((await expected('/products?status=out&search=' + sku, 200))[0].totalQty, 0);
  await expected('/products/' + product.id + '?emptyOnly=true', 204, 'DELETE');
  assert.ok(!(await expected('/stock-alerts', 200)).some(item => item.id === product.id));
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).archived, true);
});
