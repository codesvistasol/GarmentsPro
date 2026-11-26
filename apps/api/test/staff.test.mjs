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

test('staff login protects routes, attributes operations and revokes disabled sessions', async () => {
  const username = 'test-' + randomUUID();
  const password = randomUUID();
  const admin = await db.staffUser.create({
    data: { username, displayName: 'Test administrator', role: 'ADMIN', passwordHash: await hashPassword(password) },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/api';
  const request = (path, { method = 'GET', cookie, body } = {}) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  async function signIn(user, secret = password) {
    const response = await request('/auth/login', { method: 'POST', body: { username: user, password: secret } });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    return cookie.split(';')[0];
  }
  try {
    assert.equal((await request('/products')).status, 401);
    const adminCookie = await signIn(admin.username);
    const created = await request('/settings/staff', {
      method: 'POST', cookie: adminCookie,
      body: { username: username + '-warehouse', displayName: 'Warehouse tester', role: 'WAREHOUSE', password },
    });
    assert.equal(created.status, 201);
    const staff = await created.json();
    assert.equal(staff.passwordHash, undefined);
    const staffCookie = await signIn(staff.username);
    assert.equal((await request('/settings/staff', { cookie: staffCookie })).status, 403);
    const branding = { companyName: 'Test Shop', address: '', phone: '', email: '', invoiceFooter: '',
      invoiceLogo: null, invoiceLogoPlacement: 'WATERMARK', invoiceTimeZone: 'Asia/Karachi' };
    const saveBranding = (cookie, body) => request('/settings/business', { method: 'PATCH', cookie, body });
    assert.equal((await saveBranding(staffCookie, branding)).status, 403);
    assert.equal((await saveBranding(adminCookie, { ...branding, invoiceTimeZone: 'Invalid/Zone' })).status, 400);
    assert.equal((await saveBranding(adminCookie, { ...branding, invoiceLogo: 'data:image/jpeg;base64,/9j/2Q==' })).status, 400);
    const savedBranding = await saveBranding(adminCookie, branding);
    assert.equal(savedBranding.status, 200);
    assert.equal((await savedBranding.json()).invoiceLogoPlacement, 'WATERMARK');
    const category = await request('/categories', {
      method: 'POST', cookie: staffCookie, body: { name: 'Category ' + randomUUID() },
    });
    assert.equal(category.status, 201);
    const entity = await category.json();
    const event = await db.activityLog.findFirstOrThrow({ where: { entityId: entity.id } });
    assert.equal(event.actorId, staff.id);
    assert.equal(event.actorName, staff.displayName);
    const disabled = await request('/settings/staff/' + staff.id, {
      method: 'PATCH', cookie: adminCookie, body: { active: false },
    });
    assert.equal(disabled.status, 200);
    assert.equal((await request('/products', { cookie: staffCookie })).status, 401);

    const email = username + '@example.test';
    const applicant = { email, displayName: 'Signed-up tester', password };
    assert.equal((await request('/auth/signup', { method: 'POST', body: applicant })).status, 201);
    assert.equal((await request('/auth/login', { method: 'POST', body: { username: email, password } })).status, 403);
    assert.equal((await request('/settings/signup-requests')).status, 401);
    const listRequests = async () => (await request('/settings/signup-requests', { cookie: adminCookie })).json();
    const newRequest = (await listRequests()).items.find(item => item.username === email);
    assert.ok(newRequest);
    const accounts = await (await request('/settings/staff', { cookie: adminCookie })).json();
    const pending = accounts.find(user => user.username === email);
    assert.equal(pending.active, false);
    assert.deepEqual(pending.permissions, []);
    const membership = '/settings/staff/' + pending.id;
    assert.equal((await request(membership, { method: 'PATCH', cookie: adminCookie,
      body: { active: true, approveSignup: true, role: 'SALES', permissions: ['Products'] } })).status, 200);
    assert.ok(!(await listRequests()).items.some(item => item.id === newRequest.id));
    const applicantCookie = await signIn(email.toUpperCase());
    const signedIn = await (await request('/auth/session', { cookie: applicantCookie })).json();
    assert.deepEqual(signedIn.permissions, ['Products']);
    assert.equal((await request('/products', { cookie: applicantCookie })).status, 200);
    assert.equal((await request('/dashboard', { cookie: applicantCookie })).status, 403);
    assert.equal((await request('/settings/signup-requests', { cookie: applicantCookie })).status, 403);
    assert.equal((await request('/sales-orders', { cookie: applicantCookie })).status, 403);
    assert.equal((await request(membership + '/reset-code', { method: 'POST', cookie: applicantCookie })).status, 403);
    const codeResponse = await request(membership + '/reset-code', { method: 'POST', cookie: adminCookie });
    assert.equal(codeResponse.status, 200);
    const { code } = await codeResponse.json();
    const nextPassword = randomUUID();
    const reset = () => request('/auth/reset-password', { method: 'POST', body: { code, password: nextPassword } });
    assert.equal((await reset()).status, 204);
    assert.equal((await reset()).status, 400);
    assert.equal((await request('/products', { cookie: applicantCookie })).status, 401);
    const replacement = await signIn(email, nextPassword);
    assert.equal((await request(membership, { method: 'PATCH', cookie: adminCookie,
      body: { permissions: ['Categories'] } })).status, 200);
    assert.equal((await request('/products', { cookie: replacement })).status, 401);
    const updated = await signIn(email, nextPassword);
    assert.equal((await request('/products', { cookie: updated })).status, 403);
    assert.equal((await request('/categories', { cookie: updated })).status, 200);
    const rejectedEmail = 'cancel-' + email;
    assert.equal((await request('/auth/signup', { method: 'POST', body: { ...applicant, email: rejectedEmail } })).status, 201);
    const rejected = (await listRequests()).items.find(item => item.username === rejectedEmail);
    const cancel = '/settings/signup-requests/' + rejected.id + '/cancel';
    assert.equal((await request(cancel, { method: 'POST', cookie: adminCookie })).status, 204);
    assert.equal((await request(cancel, { method: 'POST', cookie: adminCookie })).status, 409);
    assert.ok(!(await listRequests()).items.some(item => item.id === rejected.id));
    assert.equal((await request('/settings/staff/' + rejected.id, { method: 'PATCH', cookie: adminCookie,
      body: { active: true, approveSignup: true } })).status, 409);
    assert.equal((await request('/auth/login', { method: 'POST', body: { username: rejectedEmail, password } })).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.$disconnect();
  }
});
