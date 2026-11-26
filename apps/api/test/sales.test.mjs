import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { allocate, cents, decimal } from '../dist/sales-money.js';

const databaseUrl = process.env.GARMENTPRO_TEST_DATABASE_URL;
assert.ok(databaseUrl, 'Set GARMENTPRO_TEST_DATABASE_URL to a migrated, disposable PostgreSQL database');
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.GARMENTPRO_TEST_ALLOW_UNAUTHENTICATED = '1';
const operatorKey = randomUUID();
process.env.SALES_RETURN_KEY = operatorKey;
const { app, db } = await import('../dist/index.js');
let server, base, customer, category;
const number = () => randomUUID();
const request = () => ({ reference: number(), requestKey: number() });
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port + '/api';
  category = await expect('/categories', 201, 'POST', { name: 'Sales test ' + number() });
  customer = await expect('/customers', 201, 'POST', {
    businessName: 'Sales customer ' + number(), type: 'SHOP', creditLimit: '2500.50', creditDays: 15,
  });
});
after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db.$disconnect();
});

async function call(path, method = 'GET', body, headers = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
async function expect(path, status, method, body, headers) {
  const result = await call(path, method, body, headers);
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}
async function stock(opening = 10) {
  const sku = 'SALE-' + number().slice(0, 20);
  const product = await expect('/products', 201, 'POST', {
    sku, name: 'Sales test shirt', categoryId: category.id, costPrice: 4, salePrice: 10,
    variants: [
      { sku: sku + '-S', size: 'S', color: 'Blue', availableQty: opening },
      { sku: sku + '-L', size: 'L', color: 'Red', availableQty: opening },
    ],
  });
  return product.variants;
}
async function order(variant, quantity, options = {}) {
  const { reserveStock = true, unitPrice = '10.00', discount = '0', customerId = customer.id } = options;
  return expect('/sales-orders', 201, 'POST', {
    number: number(), customerId, reserveStock, dueDate: '2027-01-31',
    items: [{ variantId: variant.id, quantity, unitPrice, discount }],
  });
}
const action = (order, suffix) => '/sales-orders/' + order.id + '/' + suffix;
const read = order => expect('/sales-orders/' + order.id, 200);
const confirm = order => expect(action(order, 'confirm'), 200, 'POST');
const dispatchBody = (order, quantity, extra = request()) => ({
  ...extra, destination: 'Retail shop', lines: [{ itemId: order.items[0].id, quantity }],
});
const dispatch = (order, quantity, status = 201) => expect(action(order, 'dispatches'), status, 'POST', dispatchBody(order, quantity));
const pay = (order, amount, extra = request()) => call(action(order, 'payments'), 'POST', { ...extra, amount, method: 'BANK_TRANSFER' });
const balance = id => db.variant.findUniqueOrThrow({ where: { id }, select: { availableQty: true, reservedQty: true } });
const returnLine = (order, quantity, condition, extra = {}) => ({
  ...request(), reason: 'Customer return', lines: [{ itemId: order.items[0].id, quantity, condition }], ...extra,
});

test('money arithmetic allocates fractional cents deterministically across partial postings', () => {
  assert.equal(decimal(cents('0.10') + cents('0.20')), '0.30');
  assert.deepEqual([0, 1, 2].map(index => allocate(cents('0.10'), 3, index, 1)), [3n, 3n, 4n]);
  const large = '9999999999999999999999.99';
  assert.equal(decimal(cents(large)), large);
});

test('customer search, edit and archive preserve original details on orders', async () => {
  const name = 'Wholesale ' + number();
  const buyer = await expect('/customers', 201, 'POST', {
    businessName: name, type: 'WHOLESALE', contactName: 'Buyer', address: '10 Dock Road', creditLimit: '150.25',
  });
  const [variant] = await stock();
  const sale = await order(variant, 1, { customerId: buyer.id });
  const search = new URLSearchParams({ search: name.toUpperCase(), type: 'WHOLESALE' });
  assert.equal((await expect('/customers?' + search, 200))[0].id, buyer.id);
  await expect('/customers/' + buyer.id, 200, 'PATCH', { businessName: 'Renamed shop' });
  await expect('/customers/' + buyer.id, 204, 'DELETE');
  assert.equal((await expect('/customers?status=archived&search=Renamed', 200)).find(item => item.id === buyer.id).archived, true);
  assert.equal((await read(sale)).customerName, name);
  assert.equal((await read(sale)).customerAddress, '10 Dock Road');
  await expect('/sales-orders', 400, 'POST', {
    number: number(), customerId: buyer.id, items: [{ variantId: variant.id, quantity: 1, unitPrice: '1' }],
  });
});

test('confirmation reserves without deduction, partial dispatch decrements only its variant and creates PDFs', async () => {
  const [variant, other] = await stock();
  const sale = await order(variant, 3, { unitPrice: '0.19', discount: '0.47' });
  assert.equal(sale.subtotal, '0.57');
  assert.equal(sale.total, '0.1');
  await dispatch(sale, 1, 409);
  await confirm(sale);
  assert.deepEqual(await balance(variant.id), { availableQty: 10, reservedQty: 3 });
  const first = await dispatch(sale, 1);
  assert.equal(first.total, '0.03');
  assert.equal((await read(sale)).status, 'PARTIALLY_DISPATCHED');
  assert.deepEqual(await balance(variant.id), { availableQty: 9, reservedQty: 2 });
  assert.deepEqual(await balance(other.id), { availableQty: 10, reservedQty: 0 });
  await dispatch(sale, 3, 409);
  const final = await dispatch(sale, 2);
  assert.equal(final.total, '0.07');
  assert.equal((await read(sale)).status, 'DISPATCHED');
  const ledger = await db.stockMovement.findMany({ where: { variantId: variant.id, type: 'STOCK_OUT' } });
  assert.deepEqual(ledger.map(entry => entry.quantity).sort(), [-1, -2].sort());
  assert.ok(ledger.some(entry => entry.reference === first.reference));
  const pdf = await fetch(base + '/sales-invoices/' + first.id + '.pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  if (process.env.GARMENTPRO_TEST_INVOICE_PATH) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.GARMENTPRO_TEST_INVOICE_PATH, bytes);
  }
});

test('concurrent reservations and dispatch retries cannot oversell or double deduct', async () => {
  const [variant] = await stock(5);
  const a = await order(variant, 4);
  const b = await order(variant, 4);
  const confirmed = await Promise.all([a, b].map(order => call(action(order, 'confirm'), 'POST')));
  assert.deepEqual(confirmed.map(result => result.status).sort(), [200, 409]);
  const selected = confirmed[0].status === 200 ? a : b;
  const reserveLess = await order(variant, 2, { reserveStock: false });
  await confirm(reserveLess);
  await dispatch(reserveLess, 2, 409);
  const out = await call('/inventory/movements', 'POST', {
    ...request(), variantId: variant.id, type: 'STOCK_OUT', quantity: 2, destination: 'Store', reason: 'Test reservation',
  });
  assert.equal(out.status, 409);
  const input = dispatchBody(selected, 2);
  const posts = await Promise.all([1, 2].map(() => call(action(selected, 'dispatches'), 'POST', input)));
  assert.deepEqual(posts.map(result => result.status).sort(), [201, 409]);
  assert.deepEqual(await balance(variant.id), { availableQty: 3, reservedQty: 2 });
  const cancel = await order(variant, 1);
  await confirm(cancel);
  await expect(action(cancel, 'cancel'), 200, 'POST');
  assert.deepEqual(await balance(variant.id), { availableQty: 3, reservedQty: 2 });
  const aWithout = await order(variant, 1, { reserveStock: false });
  const bWithout = await order(variant, 1, { reserveStock: false });
  await Promise.all([confirm(aWithout), confirm(bWithout)]);
  const dispatched = await Promise.all([aWithout, bWithout].map(order => call(action(order, 'dispatches'), 'POST', dispatchBody(order, 1))));
  assert.deepEqual(dispatched.map(result => result.status).sort(), [201, 409]);
  assert.deepEqual(await balance(variant.id), { availableQty: 2, reservedQty: 2 });
});

test('payments are partial, unique, and serialized against remaining balance', async () => {
  const [variant] = await stock();
  const sale = await order(variant, 3);
  assert.equal((await pay(sale, '1')).status, 409);
  await confirm(sale);
  await dispatch(sale, 3);
  const key = request();
  const retries = await Promise.all([pay(sale, '7.25', key), pay(sale, '7.25', key)]);
  assert.deepEqual(retries.map(response => response.status).sort(), [201, 409]);
  assert.equal((await read(sale)).paid, '7.25');
  const concurrent = await Promise.all([pay(sale, '20'), pay(sale, '20')]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409]);
  await expect(action(sale, 'payments'), 201, 'POST', { ...request(), amount: '2.75', method: 'CASH' });
  assert.equal((await read(sale)).paid, '30');
  assert.equal((await pay(sale, '0.01')).status, 409);
});

test('authorized returns restore saleable stock, segregate damage and reconcile credits and refunds', async () => {
  const [variant] = await stock(8);
  const sale = await order(variant, 4);
  await confirm(sale);
  await dispatch(sale, 4);
  assert.equal((await pay(sale, '35')).status, 201);
  await expect(action(sale, 'returns'), 403, 'POST', returnLine(sale, 1, 'SALEABLE'));
  const auth = { 'X-Return-Key': operatorKey };
  const input = returnLine(sale, 1, 'SALEABLE');
  const retries = await Promise.all([1, 2].map(() => call(action(sale, 'returns'), 'POST', input, auth)));
  assert.deepEqual(retries.map(result => result.status).sort(), [201, 409]);
  const restored = retries.find(result => result.status === 201).body;
  assert.equal(restored.credit, '10');
  assert.equal(restored.refundDue, '5');
  assert.deepEqual(await balance(variant.id), { availableQty: 5, reservedQty: 0 });
  assert.equal(await db.stockMovement.count({ where: { variantId: variant.id, type: 'RETURN_IN' } }), 1);
  const damaged = await expect(action(sale, 'returns'), 201, 'POST',
    returnLine(sale, 1, 'DAMAGED'), auth);
  assert.equal(damaged.refundDue, '10');
  assert.equal(damaged.lines[0].condition, 'DAMAGED');
  assert.deepEqual(await balance(variant.id), { availableQty: 5, reservedQty: 0 });
  await expect(action(sale, 'returns'), 409, 'POST', returnLine(sale, 3, 'SALEABLE'), auth);
  const current = await read(sale);
  assert.equal(current.refunded, '0');
  assert.equal(current.pendingRefund, '15');
  const path = entry => action(sale, 'returns') + '/' + entry.id + '/settlements';
  const settlement = { ...request(), amount: '5', method: 'CASH' };
  const attempts = await Promise.all([1, 2].map(() => call(path(restored), 'POST', settlement)));
  assert.deepEqual(attempts.map(result => result.status).sort(), [201, 409]);
  await expect(path(damaged), 409, 'POST', { ...request(), amount: '10.01', method: 'BANK_TRANSFER' });
  const posted = await expect(path(damaged), 201, 'POST', { ...request(), amount: '10', method: 'BANK_TRANSFER' });
  await assert.rejects(db.refundSettlement.delete({ where: { id: posted.id } }), /immutable/);
  const settled = await read(sale);
  assert.equal(settled.pendingRefund, '0');
  assert.equal(settled.refunded, '15');
  assert.equal(current.credited, '20');
  await assert.rejects(db.salesReturn.delete({ where: { id: damaged.id } }), /immutable/);
  await assert.rejects(db.salesPayment.delete({ where: { id: current.payments[0].id } }), /immutable/);
});

test('sales dashboard matches posted dispatches, credits, payments and real net units', async () => {
  const before = await expect('/sales-dashboard', 200);
  const [variant] = await stock();
  const sale = await order(variant, 4);
  await confirm(sale);
  const shipping = await dispatch(sale, 4);
  await pay(sale, '5');
  await expect(action(sale, 'returns'), 201, 'POST', returnLine(sale, 1, 'DAMAGED'), { 'X-Return-Key': operatorKey });
  const after = await expect('/sales-dashboard', 200);
  assert.equal(cents(after.totalSales) - cents(before.totalSales), 3000n);
  assert.equal(cents(after.pendingPayments) - cents(before.pendingPayments), 2500n);
  assert.equal(after.soldQuantity - before.soldQuantity, 3);
  assert.equal(after.recent[0].id, shipping.id);
});

test('500-unit warehouse workflow reconciles inventory, invoices, payments, returns and dashboard', async () => {
  const inventoryBefore = await expect('/dashboard', 200);
  const salesBefore = await expect('/sales-dashboard', 200);
  const [variant, other] = await stock(0);
  const supplier = await expect('/suppliers', 201, 'POST', { company: 'Readiness supplier ' + number() });
  const purchase = await expect('/purchase-orders', 201, 'POST', {
    supplierId: supplier.id, reference: number(), orderDate: '2026-11-22',
    items: [{ variantId: variant.id, quantity: 500, unitPrice: '4.00' }],
  });
  const receipt = { reference: number(), lines: [{ itemId: purchase.items[0].id, quantity: 500 }] };
  await expect('/purchase-orders/' + purchase.id + '/receipts', 201, 'POST', receipt);
  await expect('/purchase-orders/' + purchase.id + '/receipts', 409, 'POST', receipt);
  assert.deepEqual(await balance(variant.id), { availableQty: 500, reservedQty: 0 });

  const sale = await order(variant, 200, { unitPrice: '10.25' });
  await confirm(sale);
  assert.deepEqual(await balance(variant.id), { availableQty: 500, reservedQty: 200 });
  const first = await dispatch(sale, 150);
  assert.equal(first.total, '1537.5');
  assert.deepEqual(await balance(variant.id), { availableQty: 350, reservedQty: 50 });
  assert.equal((await pay(sale, '600.13')).status, 201);
  const partial = await read(sale);
  assert.equal(partial.paid, '600.13');
  assert.equal(cents(partial.billed) - cents(partial.paid), 93737n);
  const invoice = await fetch(base + '/sales-invoices/' + first.id + '.pdf');
  assert.equal(invoice.status, 200);
  assert.equal(Buffer.from(await invoice.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  const second = await dispatch(sale, 50);
  assert.equal(second.total, '512.5');
  assert.deepEqual(await balance(variant.id), { availableQty: 300, reservedQty: 0 });
  await expect(action(sale, 'returns'), 201, 'POST', returnLine(sale, 20, 'SALEABLE'), { 'X-Return-Key': operatorKey });
  assert.deepEqual(await balance(variant.id), { availableQty: 320, reservedQty: 0 });
  const damage = { ...request(), variantId: variant.id, type: 'DAMAGE', quantity: 10, reason: 'Quality inspection' };
  await expect('/inventory/movements', 201, 'POST', damage);
  await expect('/inventory/movements', 409, 'POST', damage);
  assert.deepEqual(await balance(variant.id), { availableQty: 310, reservedQty: 0 });
  assert.deepEqual(await balance(other.id), { availableQty: 0, reservedQty: 0 });
  await expect('/inventory/movements', 409, 'POST', {
    ...request(), variantId: variant.id, type: 'STOCK_OUT', quantity: 311, reason: 'Oversell test', destination: 'Test shop',
  });
  const history = await expect('/inventory/history?variantId=' + variant.id, 200);
  assert.equal(history.total, 5);
  const movements = new Map(history.items.map(entry => [entry.reference, [entry.type, entry.quantity, entry.balanceAfter]]));
  assert.deepEqual(movements.get(receipt.reference), ['RECEIPT', 500, 500]);
  assert.deepEqual(movements.get(first.reference), ['STOCK_OUT', -150, 350]);
  assert.deepEqual(movements.get(second.reference), ['STOCK_OUT', -50, 300]);
  assert.deepEqual(movements.get(damage.reference), ['DAMAGE', -10, 310]);
  assert.ok(history.items.some(entry => entry.type === 'RETURN_IN' && entry.quantity === 20 && entry.balanceAfter === 320));
  const final = await read(sale);
  assert.equal(cents(final.billed) - cents(final.credited) - cents(final.paid), 124487n);
  const stockDashboard = await expect('/dashboard', 200);
  assert.equal(stockDashboard.availableUnits - inventoryBefore.availableUnits, 310);
  const salesDashboard = await expect('/sales-dashboard', 200);
  assert.equal(salesDashboard.soldQuantity - salesBefore.soldQuantity, 180);
  assert.equal(cents(salesDashboard.totalSales) - cents(salesBefore.totalSales), 184500n);
  assert.equal(cents(salesDashboard.pendingPayments) - cents(salesBefore.pendingPayments), 124487n);
  assert.ok(salesDashboard.topProducts.some(item => item.id === variant.productId && item.quantity === 180));
});

test('cancelling the remainder after a partial dispatch preserves posted records and releases only remaining stock', async () => {
  const [variant] = await stock();
  const sale = await order(variant, 5);
  await confirm(sale);
  await dispatch(sale, 2);
  assert.equal((await pay(sale, '10.00')).status, 201);
  assert.deepEqual(await balance(variant.id), { availableQty: 8, reservedQty: 3 });
  const responses = await Promise.all([1, 2].map(() => call(action(sale, 'cancel'), 'POST')));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const cancelled = await read(sale);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.billed, '20');
  assert.equal(cancelled.paid, '10');
  assert.equal(cancelled.dispatches.length, 1);
  assert.deepEqual(await balance(variant.id), { availableQty: 8, reservedQty: 0 });
  await dispatch(sale, 1, 409);
});

test('sales date filters count transactions on posting date and preserve all-date outstanding balance', async () => {
  const [variant] = await stock(5);
  const sale = await order(variant, 2, { unitPrice: '1.25' });
  await confirm(sale);
  const yesterday = '2020-01-02';
  const today = new Date().toISOString().slice(0, 10);
  const beforeToday = await expect('/sales-dashboard?from=' + today + '&to=' + today, 200);
  await dispatch(sale, 2);
  const dated = await expect('/sales-dashboard?from=' + today + '&to=' + today, 200);
  assert.equal(cents(dated.totalSales) - cents(beforeToday.totalSales), 250n);
  assert.equal(dated.soldQuantity - beforeToday.soldQuantity, 2);
  const empty = await expect('/sales-dashboard?from=' + yesterday + '&to=' + yesterday, 200);
  assert.equal(empty.totalSales, '0.00');
  assert.equal(empty.soldQuantity, 0);
  assert.deepEqual(empty.recent, []);
  assert.equal(empty.pendingPayments, dated.pendingPayments);
  await expect('/sales-dashboard?from=2022-01-01&to=2021-01-01', 400);
  assert.equal(decimal(cents('-1.25')), '-1.25');
  assert.equal(decimal(cents('-0.05')), '-0.05');
});

test('posted margin keeps the order cost snapshot and reports stock movements separately', async () => {
  const [variant] = await stock(8);
  const before = await expect('/sales-dashboard', 200);
  const sale = await order(variant, 3, { unitPrice: '9.99' });
  assert.equal(sale.items[0].unitCost, '4');
  await expect('/products/' + variant.productId, 200, 'PATCH', { costPrice: 6.75 });
  await confirm(sale);
  await dispatch(sale, 3);
  await expect(action(sale, 'returns'), 201, 'POST',
    returnLine(sale, 1, 'SALEABLE'), { 'X-Return-Key': operatorKey });
  const outgoing = await call('/inventory/movements', 'POST', {
    ...request(), variantId: variant.id, type: 'DAMAGE', quantity: 1, reason: 'Damaged during stock check',
  });
  assert.equal(outgoing.status, 201);
  const after = await expect('/sales-dashboard', 200);
  assert.equal(cents(after.totalSales) - cents(before.totalSales), 1998n);
  assert.equal(cents(after.soldCost) - cents(before.soldCost), 800n);
  assert.equal(cents(after.grossProfit) - cents(before.grossProfit), 1198n);
  assert.equal(after.stockIn - before.stockIn, 1);
  assert.equal(after.stockOut - before.stockOut, 4);
  assert.equal(after.damaged - before.damaged, 1);
  assert.equal(cents(after.damageCostEstimate) - cents(before.damageCostEstimate), 675n);
});

test('quick sale posts invoice, full payment and stock exactly once across concurrent retries', async () => {
  const [variant] = await stock(8);
  const input = {
    requestKey: number(), destination: 'Local shop counter', paymentMethod: 'CASH',
    items: [{ variantId: variant.id, quantity: 3, unitPrice: '10.00' }],
  };
  const receipts = await Promise.all([call('/sales-checkout', 'POST', input), call('/sales-checkout', 'POST', input)]);
  assert.deepEqual(receipts.map(receipt => receipt.status).sort(), [200, 201]);
  const sale = receipts[0].body;
  assert.equal(receipts[1].body.id, sale.id);
  assert.equal(sale.customerName, 'Walk-in customer');
  assert.equal(sale.status, 'DISPATCHED');
  assert.equal(sale.billed, '30');
  assert.equal(sale.paid, '30');
  assert.equal(sale.payments.length, 1);
  assert.equal(sale.dispatches.length, 1);
  assert.deepEqual(await balance(variant.id), { availableQty: 5, reservedQty: 0 });
  const records = await db.stockMovement.findMany({ where: { variantId: variant.id, type: 'STOCK_OUT' } });
  assert.deepEqual(records.map(record => [record.reference, record.quantity]), [[sale.dispatches[0].reference, -3]]);
  await expect('/sales-checkout', 409, 'POST', { ...input, items: [{ ...input.items[0], quantity: 2 }] });
  const invoice = await fetch(base + '/sales-invoices/' + sale.dispatches[0].id + '.pdf');
  assert.equal(invoice.status, 200);
  const bytes = Buffer.from(await invoice.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  if (process.env.GARMENTPRO_QUICK_SALE_INVOICE_PATH) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.GARMENTPRO_QUICK_SALE_INVOICE_PATH, bytes);
  }
});

test('quick sale rolls back when any variant is unavailable or stale and supports credit invoices', async () => {
  const [first, second] = await stock(5);
  const reserved = await order(second, 4);
  await confirm(reserved);
  const input = {
    requestKey: number(), customerId: customer.id, destination: 'Warehouse pickup',
    items: [
      { variantId: first.id, quantity: 2, unitPrice: '10.00' },
      { variantId: second.id, quantity: 2, unitPrice: '10.00' },
    ],
  };
  await expect('/sales-checkout', 409, 'POST', input);
  assert.equal(await db.salesOrder.count({ where: { number: 'POS-' + input.requestKey.replace(/-/g, '').toUpperCase() } }), 0);
  assert.deepEqual(await balance(first.id), { availableQty: 5, reservedQty: 0 });
  assert.deepEqual(await balance(second.id), { availableQty: 5, reservedQty: 4 });
  const invalidPrice = { ...input, items: [{ ...input.items[0], unitPrice: '0.01' }] };
  await expect('/sales-checkout', 409, 'POST', invalidPrice);
  await expect('/sales-checkout', 400, 'POST', { ...input, customerId: undefined });
  const sale = await expect('/sales-checkout', 201, 'POST', { ...input, items: [input.items[0]] });
  assert.equal(sale.billed, '20');
  assert.equal(sale.paid, '0');
  assert.equal(sale.payments.length, 0);
  assert.deepEqual(await balance(first.id), { availableQty: 3, reservedQty: 0 });
});

test('Day Look reconciles posted receipts, dispatches, payments and stock on the selected date', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const before = await expect('/day-look?day=' + today, 200);
  const [variant] = await stock(0);
  const supplier = await expect('/suppliers', 201, 'POST', { company: 'Daily test ' + number() });
  const purchase = await expect('/purchase-orders', 201, 'POST', {
    supplierId: supplier.id, reference: number(), orderDate: today,
    items: [{ variantId: variant.id, quantity: 11, unitPrice: '4.25' }],
  });
  await expect('/purchase-orders/' + purchase.id + '/receipts', 201, 'POST', {
    reference: number(), lines: [{ itemId: purchase.items[0].id, quantity: 11 }],
  });
  const input = { requestKey: number(), paymentMethod: 'CASH', items: [{ variantId: variant.id, quantity: 2, unitPrice: '10' }] };
  const sale = await expect('/sales-checkout', 201, 'POST', input);
  await expect('/sales-checkout', 200, 'POST', input);
  const after = await expect('/day-look?day=' + today, 200);
  assert.equal(after.receipts - before.receipts, 1);
  assert.equal(after.dispatches - before.dispatches, 1);
  assert.equal(after.paymentCount - before.paymentCount, 1);
  assert.equal(after.stockIn - before.stockIn, 11);
  assert.equal(after.stockOut - before.stockOut, 2);
  assert.equal(cents(after.netSales) - cents(before.netSales), 2000n);
  assert.equal(cents(after.payments) - cents(before.payments), 2000n);
  assert.ok(after.ledgerRows.some(item => item.reference === sale.number && item.quantity === -2));
  assert.ok(after.buyers.some(item => item.order.number === sale.number && item.order.customerName === 'Walk-in customer' && cents(item.total) === 2000n));
  const empty = await expect('/day-look?day=2000-01-01', 200);
  assert.equal(empty.dispatches, 0);
  assert.equal(empty.netSales, '0.00');
  assert.deepEqual(empty.ledgerRows, []);
  await expect('/day-look?day=bad', 400);
});

test('activity history records committed changes once and cannot be edited or deleted', async () => {
  const [variant] = await stock(3);
  const sku = variant.sku;
  const before = await expect('/activity-logs?search=' + sku + '&area=Catalogue', 200);
  assert.ok(before.items.some(item => item.action === 'Created variant'));
  const input = { requestKey: number(), paymentMethod: 'BANK_TRANSFER', items: [{ variantId: variant.id, quantity: 1, unitPrice: '10' }] };
  const sale = await expect('/sales-checkout', 201, 'POST', input);
  await expect('/sales-checkout', 200, 'POST', input);
  await expect('/sales-checkout', 409, 'POST', { ...input, items: [{ ...input.items[0], quantity: 2 }] });
  const search = '?search=' + sale.number;
  const log = await expect('/activity-logs' + search + '&area=Payments', 200);
  assert.equal(log.total, 1);
  assert.equal(log.items[0].action, 'Recorded payment');
  assert.equal((await expect('/activity-logs' + search + '&area=Inventory', 200)).total, 1);
  const catalogAfterSale = await expect('/activity-logs?search=' + sku + '&area=Catalogue', 200);
  assert.equal(catalogAfterSale.total, before.total);
  await assert.rejects(db.activityLog.update({ where: { id: BigInt(log.items[0].id) }, data: { action: 'Changed' } }), /immutable/);
  await assert.rejects(db.activityLog.delete({ where: { id: BigInt(log.items[0].id) } }), /immutable/);
  assert.equal((await expect('/activity-logs' + search + '&area=Payments&from=2000-01-01&to=2000-01-01', 200)).total, 0);
});
