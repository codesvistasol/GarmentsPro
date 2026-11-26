import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = new URL(process.env.GARMENTPRO_DEMO_API_URL ?? 'http://127.0.0.1:4000/api');
if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname) || base.pathname.replace(/\/$/, '') !== '/api') {
  throw new Error('Demo setup is restricted to a local GarmentPro API.');
}

const catalogue = [
  ['Pant Coats', ['Pent coat', 'Pant Coat'], ['Slim Fit Two-Piece', 'Classic Two-Piece', 'Three-Piece Suit', 'Linen Suit', 'Double-Breasted Suit'], 4100, 6200],
  ['Waistcoats', ['Vase coat', 'Vest Coat'], ['Formal Waistcoat', 'Linen Waistcoat', 'Wedding Waistcoat', 'Knitted Vest', 'Casual Waistcoat'], 1900, 2950],
  ['Jeans', [], ['Slim Jeans', 'Straight Jeans', 'Relaxed Jeans', 'Stretch Jeans', 'Raw Denim Jeans'], 1850, 2950],
  ['T-Shirts', ['T-Shirt'], ['Crewneck Tee', 'V-Neck Tee', 'Graphic Tee', 'Oversized Tee', 'Long Sleeve Tee'], 460, 850],
  ['Casual Shirts', ['Casual Shirt'], ['Oxford Shirt', 'Denim Shirt', 'Flannel Shirt', 'Linen Shirt', 'Printed Shirt'], 1050, 1750],
  ['Trousers', [], ['Chino Trousers', 'Cargo Trousers', 'Linen Trousers', 'Jogger Trousers', 'Pleated Trousers'], 1280, 2100],
  ['Dress Pants', ['Dress Pantss'], ['Slim Dress Pants', 'Classic Dress Pants', 'Pleated Dress Pants', 'Tapered Dress Pants', 'Wool Dress Pants'], 1750, 2800],
  ['Belts', [], ['Leather Belt', 'Braided Belt', 'Canvas Belt', 'Reversible Belt', 'Dress Belt'], 520, 950],
  ['Ties', ['Tiess'], ['Silk Tie', 'Skinny Tie', 'Knitted Tie', 'Bow Tie', 'Patterned Tie'], 440, 820],
  ['Cloth', ['Clothss', 'Cloths'], ['Cotton Fabric', 'Linen Fabric', 'Denim Fabric', 'Wool Blend Fabric', 'Polyester Fabric'], 1000, 1580],
  ["Ladies' Dresses & Frocks", ['Ladies Dress', 'Ladies Dress Fraqss'], ['Maxi Dress', 'Midi Dress', 'Casual Frock', 'Party Frock', 'Embroidered Dress'], 2450, 3900],
  ["Children's Dresses", ['Childs Dress', 'Chileds Dress'], ['Cotton Kids Dress', 'Party Kids Dress', 'School Pinafore', 'Printed Kids Frock', 'Festive Kids Dress'], 900, 1550],
];

const username = process.env.GARMENTPRO_ADMIN_USERNAME;
const password = process.env.GARMENTPRO_ADMIN_PASSWORD;
if (!username || !password) throw new Error('Set the local demo administrator credentials in the process environment.');
const login = await fetch(base.origin + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
});
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!login.ok || !cookie) throw new Error('Local demo sign-in failed (' + login.status + ').');

async function request(path, data, method = 'POST') {
  const response = await fetch(base.origin + '/api' + path, {
    method: data === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(path + ' (' + response.status + '): ' + (await response.text()).slice(0, 500));
  return response.status === 204 ? undefined : response.json();
}

const prefix = 'DEMO-GP-';
const today = new Date().toISOString().slice(0, 10);
const widths = ['Black', 'Navy', 'Sand', 'Olive', 'Ivory'];
const categories = await request('/categories');
const existingProducts = await request('/products?search=' + prefix);
const existingOrders = await request('/sales-orders');
const existingPurchases = await request('/purchase-orders');
const existingSuppliers = await request('/suppliers?search=GarmentPro%20Demo');
const existingCustomers = await request('/customers?search=GarmentPro%20Demo');
const families = [];

async function category(name, aliases = [], parentId = null) {
  const existing = categories.find(item => (item.parentId ?? null) === parentId &&
    [name, ...aliases].some(value => value.toLowerCase() === item.name.toLowerCase()));
  if (existing) return existing;
  const created = await request('/categories', { name, parentId });
  categories.push(created);
  return created;
}

for (const [index, [name, aliases, styles, baseCost, basePrice]] of catalogue.entries()) {
  const code = String(index + 1).padStart(2, '0');
  const parent = await category(name, aliases);
  const products = [];
  for (const [styleIndex, style] of styles.entries()) {
    const subcategory = await category(style, [], parent.id);
    const sku = prefix + code + '-' + (styleIndex + 1);
    const costPrice = baseCost + styleIndex * 65;
    const salePrice = basePrice + styleIndex * 100;
    const sizes = index === 9 ? ['1 m', '2 m'] : [2, 5, 6].includes(index) ? ['30', '32'] : index === 8 ? ['Standard', 'Long'] : ['M', 'L'];
    const colors = [widths[styleIndex], widths[(styleIndex + 2) % widths.length]];
    const image = styleIndex === 0
      ? 'data:image/jpeg;base64,' + (await readFile(new URL('./demo-photos/' + code + '.jpg', import.meta.url))).toString('base64')
      : undefined;
    const existing = existingProducts.find(item => item.sku === sku);
    const product = existing ?? await request('/products', {
      sku, name: 'Demo ' + style, categoryId: subcategory.id, costPrice, salePrice,
      image, description: 'Local demonstration product. Any product photo is illustrative.',
      variants: sizes.map((size, variantIndex) => ({
        sku: sku + '-' + (variantIndex + 1), color: colors[variantIndex], size, availableQty: 0, reorderPoint: 8,
      })),
    });
    if (existing && image && !existing.image) await request('/products/' + existing.id, { image }, 'PATCH');
    products.push(product);
  }
  const supplierName = 'GarmentPro Demo Supplier ' + code;
  const supplier = existingSuppliers.find(item => item.company === supplierName) ??
    await request('/suppliers', { company: supplierName, contactName: 'Sample purchasing desk' });
  const purchaseRef = prefix + 'PO-' + code;
  const purchase = existingPurchases.find(item => item.reference === purchaseRef) ?? await request('/purchase-orders', {
    supplierId: supplier.id, reference: purchaseRef, orderDate: today,
    items: products.flatMap((product, styleIndex) => product.variants.map((variant, index) => ({
      variantId: variant.id, quantity: (index ? 19 : 37) + styleIndex * 4, unitPrice: product.costPrice,
    }))),
  });
  const receiptRef = prefix + 'GR-' + code;
  if (!purchase.receipts.some(receipt => receipt.reference === receiptRef)) {
    const lines = purchase.items.filter(item => item.quantity > item.receivedQty)
      .map(item => ({ itemId: item.id, quantity: item.quantity - item.receivedQty }));
    if (lines.length) await request('/purchase-orders/' + purchase.id + '/receipts', { reference: receiptRef, lines });
  }
  families.push({ code, products, parent });
}

const buyers = [];
for (const name of ['Retail', 'Wholesale', 'Boutique']) {
  const businessName = 'GarmentPro Demo ' + name;
  buyers.push(existingCustomers.find(item => item.businessName === businessName) ??
    await request('/customers', { businessName, type: name === 'Wholesale' ? 'WHOLESALE' : 'SHOP', creditDays: 14 }));
}

for (const [index, { code, products }] of families.entries()) {
  const orderNumber = prefix + 'SO-' + code;
  let order = existingOrders.find(item => item.number === orderNumber);
  const date = new Date(Date.parse(today) + 14 * 86_400_000).toISOString().slice(0, 10);
  if (!order) {
    order = await request('/sales-orders', {
      number: orderNumber, customerId: buyers[index % buyers.length].id, dueDate: date, reserveStock: true,
      items: products.slice(0, 3).map((product, lineIndex) => ({
        variantId: product.variants[0].id, quantity: Math.min(35, 14 + index * 2 + lineIndex),
        unitPrice: index === 7 && lineIndex === 0 ? (Number(product.costPrice) - 100).toFixed(2) : product.salePrice,
        discount: lineIndex === 1 ? '120' : '0',
      })),
    });
  }
  if (index === 11 || order.status === 'CANCELLED') continue;
  if (order.status === 'DRAFT') order = await request('/sales-orders/' + order.id + '/confirm', {});
  const dispatchRef = prefix + 'DSP-' + code;
  if (order.status !== 'DISPATCHED' && !order.dispatches.some(dispatch => dispatch.reference === dispatchRef)) {
    const lines = order.items.map(item => {
      const remaining = item.quantity - item.dispatched;
      return { itemId: item.id, quantity: index % 4 === 0 ? Math.ceil(remaining / 2) : remaining };
    }).filter(item => item.quantity > 0);
    if (lines.length) await request('/sales-orders/' + order.id + '/dispatches', {
      reference: dispatchRef, requestKey: randomUUID(), destination: 'GarmentPro local demo receiving desk', lines,
    });
  }
  order = await request('/sales-orders/' + order.id);
  const paymentRef = prefix + 'PAY-' + code;
  if (index % 3 !== 2 && !order.payments.some(payment => payment.reference === paymentRef)) {
    const balance = Number(order.billed) - Number(order.credited) - Number(order.paid) + Number(order.refunded);
    const amount = index % 3 === 0 ? balance : Math.floor(balance * 50) / 100;
    if (amount > 0) await request('/sales-orders/' + order.id + '/payments', {
      reference: paymentRef, requestKey: randomUUID(), amount: amount.toFixed(2), method: index % 2 ? 'BANK_TRANSFER' : 'CASH',
    });
  }
}

console.log('Demo ready: ' + families.length + ' category groups, ' + families.reduce((sum, family) => sum + family.products.length, 0) + ' demo products, and linked receipts, dispatches and payments.');
