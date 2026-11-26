import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';

assert.ok(process.env.GARMENTPRO_TEST_DATABASE_URL, 'Use a disposable migrated database');
process.env.DATABASE_URL = process.env.GARMENTPRO_TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
delete process.env.GARMENTPRO_TEST_ALLOW_UNAUTHENTICATED;
const { app, db } = await import('../dist/index.js');
const { hashPassword } = await import('../dist/staff.js');

test('shop branches isolate stock, sales, invoices, finance and staff permissions', { timeout: 180000 }, async () => {
  const password = randomUUID();
  const admin = await db.staffUser.create({ data: {
    username: 'admin-' + randomUUID(), displayName: 'Branch test admin', role: 'ADMIN', passwordHash: await hashPassword(password),
  } });
  const employee = await db.staffUser.create({ data: {
    username: 'staff-' + randomUUID(), displayName: 'Branch test staff', role: 'SALES', passwordHash: await hashPassword(password),
  } });
  const manager = await db.staffUser.create({ data: {
    username: 'manager-' + randomUUID(), displayName: 'Branch test manager', role: 'SALES', passwordHash: await hashPassword(password),
  } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/api';
  async function call(path, status, cookie, method = 'GET', body) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status, path + ' ' + (response.status === status ? '' : await response.text()));
    return response;
  }
  async function login(user) {
    const result = await call('/auth/login', 200, '', 'POST', { username: user.username, password });
    return result.headers.get('set-cookie').split(';')[0];
  }
  try {
    const adminCookie = await login(admin);
    const shop = await (await call('/locations/shops', 201, adminCookie, 'POST', { name: 'Shop ' + randomUUID() })).json();
    const createBranch = async name => (await call('/locations/branches', 201, adminCookie, 'POST', { shopId: shop.id, name })).json();
    const a = await createBranch('North');
    const b = await createBranch('South');
    const scope = branch => '/branch/' + branch.id;
    async function opening(branch, availableQty) {
      const path = scope(branch);
      const category = await (await call(path+'/categories', 201, adminCookie, 'POST', { name: 'Tops' })).json();
      const product = await (await call(path+'/products', 201, adminCookie, 'POST', {
        name: 'Shirt', sku: 'SHIRT-01', categoryId: category.id, costPrice: 5, salePrice: 10,
        variants: [{ size: 'M', color: 'Blue', sku: 'SHIRT-01-M', availableQty }],
      })).json();
      return product.variants[0];
    }
    const variantA = await opening(a, 10);
    const variantB = await opening(b, 20);
    assert.notEqual(variantA.id, variantB.id);
    const sale = await (await call(scope(a)+'/sales-checkout', 201, adminCookie, 'POST', {
      requestKey: randomUUID(), paymentMethod: 'CASH', items: [{ variantId: variantA.id, quantity: 2, unitPrice: '10' }],
    })).json();
    const invoice = '/sales-invoices/' + sale.dispatches[0].id + '.pdf';
    await call(scope(a)+invoice, 200, adminCookie);
    await call(scope(b)+invoice, 404, adminCookie);
    assert.equal((await (await call(scope(a)+'/dashboard',200,adminCookie)).json()).availableUnits, 8);
    assert.equal((await (await call(scope(b)+'/dashboard',200,adminCookie)).json()).availableUnits, 20);
    const summaries = await (await call('/locations/summary',200,adminCookie)).json();
    assert.deepEqual(summaries.find(row=>row.id===a.id).payments,'20.00');
    assert.deepEqual(summaries.find(row=>row.id===b.id).payments,'0.00');
    const access = '/locations/branches/' + a.id + '/access';
    await call(access, 204, adminCookie, 'PUT', { username: employee.username, permissions: ['Dashboard'] });
    const staffCookie = await login(employee);
    const locations = await (await call('/locations',200,staffCookie)).json();
    assert.deepEqual(locations.branches.map(branch => branch.id), [a.id]);
    await call('/dashboard',403,staffCookie);
    await call(scope(a)+'/dashboard',200,staffCookie);
    await call(scope(a)+'/sales-orders',403,staffCookie);
    await call(scope(b)+'/dashboard',403,staffCookie);
    await call('/locations/branches/'+b.id+'/access',403,staffCookie);
    await call(access, 204, adminCookie, 'PUT', { username: manager.username, permissions: ['Dashboard','Reports'], manager: true });
    const managerCookie = await login(manager);
    assert.deepEqual((await (await call('/locations/summary',200,managerCookie)).json()).map(row=>row.id), [a.id]);
    await call(access, 403, managerCookie, 'PUT', { username: employee.username, permissions: ['Payments'] });
    await call(access, 204, managerCookie, 'PUT', { username: employee.username, permissions: ['Dashboard'] });
    await call(access+'/'+employee.id,204,managerCookie,'DELETE');
    const after = await login(employee);
    await call('/dashboard',403,after);
    await call(scope(a)+'/dashboard',403,after);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await db.$disconnect();
  }
});
