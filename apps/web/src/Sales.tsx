import type { Role } from './StaffLogin';
import { ListFilters, emptyFilters, matchesFilters } from './ListFilters';
import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, CalendarDays, Package, ReceiptText, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { api, base, send } from './api';
import { PricingPanel } from './PricingPanel';
import type { Customer } from './Customers';
import { Editor, QueryStatus, useOrderDetails, useQuery, variantLabel, type StockVariant } from './warehouse-ui';

const statuses = { DRAFT: 'Draft', CONFIRMED: 'Confirmed', PARTIALLY_DISPATCHED: 'Partially dispatched', DISPATCHED: 'Dispatched', CANCELLED: 'Cancelled' };
const methods = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer' };
type Method = keyof typeof methods;
type Item = { id: string; variantSku: string; productName: string; color: string; size: string; quantity: number; dispatched: number; returned: number; unitPrice: string; discount: string; total: string };
type Dispatch = { id: string; reference: string; total: string; createdAt: string };
type Payment = { id: string; reference: string; method: Method; amount: string; createdAt: string };
type Return = { id: string; reference: string; reason: string; credit: string; refunded: string; refundDue: string; refundMethod: Method | null; settlements: Payment[]; lines: { id: string; itemId: string; quantity: number; condition: 'SALEABLE' | 'DAMAGED' }[]; createdAt: string };
type SalesOrder = {
  id: string; number: string; customerName: string; status: keyof typeof statuses; reserveStock: boolean; dueDate: string; createdAt: string;
  subtotal: string; total: string; billed: string; credited: string; paid: string; refunded: string; pendingRefund: string;
  items: Item[]; dispatches: Dispatch[]; payments: Payment[]; returns: Return[];
};
type Action = 'confirm' | 'cancel' | 'dispatches' | 'payments' | 'returns';

function cents(value: string) {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const amount = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -amount : amount;
}

function price(value: string | bigint) {
  const amount = typeof value === 'string' ? cents(value) : value;
  const absolute = amount < 0n ? -amount : amount;
  return (amount < 0n ? '−' : '') + 'PKR ' + (absolute / 100n).toLocaleString('en-PK') + '.' + (absolute % 100n).toString().padStart(2, '0');
}
const due = (order: SalesOrder) => cents(order.billed) - cents(order.credited) - cents(order.paid) + cents(order.refunded) + cents(order.pendingRefund);
const refundDue = (entry: Return) => cents(entry.refundDue) - entry.settlements.reduce((sum, item) => sum + cents(item.amount), 0n);
const day = (value: string) => value.slice(0, 10);
const itemName = (item: Item) => item.productName + ' · ' + item.color + ' / ' + item.size + ' (' + item.variantSku + ')';

export default function Sales({ paymentsOnly = false, returnsOnly = false, onChange, role, permissions }: { paymentsOnly?: boolean; returnsOnly?: boolean; permissions: string[]; onChange: () => void; role: Role }) {
  const has = (module: string) => role === 'ADMIN' || permissions.includes(module);
  const canOrder = !returnsOnly && has('Sales & Distribution') && (role === 'ADMIN' || role === 'SALES');
  const canDispatch = !returnsOnly && has('Sales & Distribution') && role !== 'FINANCE';
  const canPay = !returnsOnly && has('Payments');
  const canReturn = has('Returns');
  const [revision, setRevision] = useState(0);
  const [customerId, setCustomerId] = useState('');
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [settling, setSettling] = useState<Return | null>(null);
  const customers = useQuery<Customer[]>('/customers?status=all', [], 0, role !== 'WAREHOUSE');
  const variants = useQuery<StockVariant[]>('/inventory/variants', [], revision, canOrder);
  const orders = useQuery<SalesOrder[]>('/sales-orders' + (customerId ? '?customerId=' + encodeURIComponent(customerId) : ''), [], revision);
  const [filters, setFilters] = useState(emptyFilters);
  const [statusFilter, setStatusFilter] = useState('');
  const visibleOrders = orders.data.filter(order => {
    if (statusFilter && order.status !== statusFilter) return false;
    if (returnsOnly && !order.items.some(item => item.dispatched > 0)) return false;
    const searchable = [order.number,order.customerName,...order.dispatches.map(invoice => invoice.reference),...order.items.flatMap(item=>[item.productName,item.variantSku])];
    if (!paymentsOnly) return matchesFilters(filters, order.createdAt, ...searchable);
    const posts = [...order.payments, ...order.returns, ...order.returns.flatMap(entry => entry.settlements)];
    return ((!filters.from && !filters.to) && matchesFilters(filters, order.createdAt, ...searchable)) ||
      posts.some(post => matchesFilters(filters, post.createdAt, ...searchable,post.reference));
  });
  const paymentTotals = visibleOrders.reduce((totals, order) => ({
    paid: totals.paid + order.payments.filter(post => matchesFilters({ ...filters, search: '' }, post.createdAt, post.reference)).reduce((sum, post) => sum + cents(post.amount), 0n),
    due: totals.due + due(order),
    pending: totals.pending + cents(order.pendingRefund),
  }), { paid: 0n, due: 0n, pending: 0n });
  const current = orders.data.find(order => order.id === selected);
  const { details, reveal } = useOrderDetails(current?.id ?? '');
  const active = customers.data.filter(customer => !customer.archived);
  const sellable = variants.data.filter(variant => variant.saleActive);
  function reload() { setRevision(previous => previous + 1); onChange(); }

  return <>
    <section className="panel warehouse-panel no-print">
      <div className="panel-head"><h2>{returnsOnly ? 'Sales returns' : paymentsOnly ? 'Customer payments' : 'Sales orders'}</h2>
        {!paymentsOnly && canOrder && <button className="primary" disabled={!active.length || !sellable.length} onClick={() => setCreating(true)}>New sales order</button>}
      </div>
      {!paymentsOnly && canOrder && !customers.loading && !variants.loading && (!active.length || !sellable.length) &&
        <p className="hint">An active customer and a product variant are required to create an order.</p>}
      {role !== 'WAREHOUSE' && <label className="warehouse-filter">Customer<select value={customerId} onChange={event => { setCustomerId(event.target.value); setSelected(''); }}>
        <option value="">All customers</option>{customers.data.map(customer => <option key={customer.id} value={customer.id}>{customer.businessName}</option>)}
      </select></label>}
      <ListFilters label={paymentsOnly ? "Find payments or orders" : "Find sales orders"} dateLabel={paymentsOnly ? "Payment or return posted" : "Sales order created"} onApply={setFilters}>
        <label>Order status<select value={statusFilter} onChange={event=>setStatusFilter(event.target.value)}><option value="">All statuses</option>{Object.entries(statuses).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      </ListFilters>
      <QueryStatus loading={orders.loading || customers.loading || (!paymentsOnly && variants.loading)}
        error={orders.error || customers.error || (!paymentsOnly ? variants.error : '')} />
      {returnsOnly && <p className="hint">Find the original sale by order number or customer, open it and select Process return. Choose the product variant, quantity and condition. Saleable items return to stock. Refunds, when due, are settled separately.</p>}
      {paymentsOnly && !orders.loading && !orders.error && <div className="sales-headline-metrics">
        <article className="sales-headline-card"><div><h3>Payments received</h3><strong>{price(paymentTotals.paid)}</strong><p>Matching accounts and payment dates</p></div></article>
        <article className="sales-headline-card"><div><h3>Outstanding balance</h3><strong>{price(paymentTotals.due)}</strong><p>Current balance for matching accounts</p></div></article>
        <article className="sales-headline-card"><div><h3>Refunds payable</h3><strong>{price(paymentTotals.pending)}</strong><p>Pending refunds for matching accounts</p></div></article>
      </div>}
      <div className="table-scroll"><table className="order-list-table sales-list"><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Order total</th><th>Balance due</th><th>Due date</th><th>Actions</th></tr></thead>
        <tbody>{visibleOrders.map(order => <tr key={order.id}>
          <td><b>{order.number}</b></td><td>{order.customerName}</td><td>{statuses[order.status]}</td>
          <td>{price(order.total)}</td><td>{price(due(order))}</td><td>{day(order.dueDate)}</td>
          <td className="table-action"><button className="textbtn detail-link" onClick={() => selected === order.id ? reveal() : setSelected(order.id)}>View {paymentsOnly ? 'account' : returnsOnly ? 'sale for return' : 'order'}</button></td>
        </tr>)}</tbody>
      </table></div>
      {!orders.loading && !visibleOrders.length && <p className="empty">No sales orders found.</p>}
    </section>
    {current && <section className="panel warehouse-panel order-detail" ref={details} tabIndex={-1} aria-label={paymentsOnly ? "Customer account details" : "Sales order details"}>
      <div className="panel-head"><div><h2>Sales order {current.number}</h2><p>{current.customerName} · {statuses[current.status]} · Due {day(current.dueDate)}</p></div>
        <div className="warehouse-actions">
          <button className="textbtn" onClick={() => setSelected('')}>Close details</button>
          {!paymentsOnly && canOrder && current.status === 'DRAFT' && <button className="primary" onClick={() => setAction('confirm')}>Confirm order</button>}
          {!paymentsOnly && canOrder && ['DRAFT', 'CONFIRMED', 'PARTIALLY_DISPATCHED'].includes(current.status) &&
            <button className="textbtn" onClick={() => setAction('cancel')}>{current.status === 'PARTIALLY_DISPATCHED' ? 'Cancel remaining units' : 'Cancel order'}</button>}
          {!paymentsOnly && canDispatch && ['CONFIRMED', 'PARTIALLY_DISPATCHED'].includes(current.status) &&
            <button className="primary" onClick={() => setAction('dispatches')}>Dispatch goods</button>}
          {canPay && due(current) > 0n && <button className="primary" onClick={() => setAction('payments')}>Record payment</button>}
          {!paymentsOnly && canReturn && current.items.some(item => item.dispatched > item.returned) &&
            <button className="textbtn" onClick={() => setAction('returns')}>Process return</button>}
        </div>
      </div>
      <p className="hint">Subtotal {price(current.subtotal)} · Order total {price(current.total)} · Invoiced {price(current.billed)} ·
        Credits {price(current.credited)} · Paid {price(current.paid)} · Refunded {price(current.refunded)} · Pending refund {price(current.pendingRefund)} · Balance {price(due(current))}</p>
      {!paymentsOnly && <>
        <div className="table-scroll"><table><thead><tr><th>Item</th><th>Ordered</th><th>Dispatched</th><th>Returned</th><th>Unit price</th><th>Discount</th><th>Total</th></tr></thead>
          <tbody>{current.items.map(item => <tr key={item.id}><td>{itemName(item)}</td><td>{item.quantity}</td><td>{item.dispatched}</td>
            <td>{item.returned}</td><td>{price(item.unitPrice)}</td><td>{price(item.discount)}</td><td>{price(item.total)}</td></tr>)}</tbody>
        </table></div>
        <h3>Invoices</h3>
        {current.dispatches.length ? <ul className="receipt-list">{current.dispatches.map(invoice => <li key={invoice.id}>
          {invoice.reference} · {day(invoice.createdAt)} · {price(invoice.total)}{' '}
          <a className="textbtn" href={base + '/sales-invoices/' + invoice.id + '.pdf?view=1'} target="_blank" rel="noreferrer">View or print</a>{' '}
          <a className="textbtn" href={base + '/sales-invoices/' + invoice.id + '.pdf'}>Download PDF</a>
        </li>)}</ul> : <p className="hint">Invoices appear after dispatch.</p>}
      </>}
      <h3>Payments and returns</h3>
      <div className="table-scroll"><table><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Amount</th><th>Details</th></tr></thead>
        <tbody>
          {current.payments.filter(payment=>!paymentsOnly||matchesFilters({...filters,search:""},payment.createdAt,payment.reference)).map(payment => <tr key={payment.id}><td>{day(payment.createdAt)}</td><td>{payment.reference}</td>
            <td>Payment</td><td>{price(payment.amount)}</td><td>{methods[payment.method]}</td></tr>)}
          {current.returns.filter(entry=>!paymentsOnly||matchesFilters({...filters,search:""},entry.createdAt,entry.reference)).map(entry => <tr key={entry.id}><td>{day(entry.createdAt)}</td><td>{entry.reference}</td>
            <td>Return credit</td><td>{price(entry.credit)}</td><td>{entry.reason} · {entry.lines.map(line =>
              line.quantity + ' ' + line.condition.toLowerCase() + ' (' + (current.items.find(item => item.id === line.itemId)?.variantSku ?? line.itemId) + ')',
            ).join(', ')}{entry.refundMethod && ' · Refunded ' + price(entry.refunded) + ' by ' + methods[entry.refundMethod]}
            {refundDue(entry) > 0n && <> · Refund due {price(refundDue(entry))}
              {canReturn && <button className="textbtn" onClick={() => setSettling(entry)}>Record refund settlement</button>}</>}
            </td></tr>)}
          {current.returns.flatMap(entry => entry.settlements).filter(entry => !paymentsOnly || matchesFilters({...filters,search:""},entry.createdAt,entry.reference)).map(entry =>
            <tr key={entry.id}><td>{day(entry.createdAt)}</td><td>{entry.reference}</td><td>Refund settlement</td><td>{price(entry.amount)}</td><td>{methods[entry.method]}</td></tr>,
          )}
        </tbody>
      </table></div>
      {!current.payments.length && !current.returns.length && <p className="hint">No payments or returns yet.</p>}
    </section>}
    {creating && <SalesOrderEditor customers={active} variants={sellable} onClose={() => setCreating(false)}
      onCreated={order => { setCustomerId(''); setSelected(order.id); reload(); }} />}
    {current && action && <PostingEditor key={action} order={current} action={action} onClose={() => setAction(null)} onPosted={reload} />}
    {current && settling && <RefundEditor order={current} entry={settling} onClose={() => setSettling(null)} onSaved={reload} />}
  </>;
}

type DraftItem = { key: number; variantId: string; quantity: string; unitPrice: string; discount: string };
const newItem = (key: number): DraftItem => ({ key, variantId: '', quantity: '1', unitPrice: '', discount: '0' });
const numeric = /^\d{1,22}(\.\d{1,2})?$/;

function SalesOrderEditor({ customers, variants, onClose, onCreated }: {
  customers: Customer[]; variants: StockVariant[]; onClose: () => void; onCreated: (order: SalesOrder) => void;
}) {
  const [form, setForm] = useState({ customerId: '', number: '', dueDate: '', reserveStock: true });
  const [items, setItems] = useState([newItem(1)]);
  const [nextKey, setNextKey] = useState(2);
  const change = (key: number, patch: Partial<DraftItem>) => setItems(items.map(item => item.key === key ? { ...item, ...patch } : item));
  const subtotal = items.reduce((sum, item) => sum + (numeric.test(item.unitPrice) && /^\d+$/.test(item.quantity)
    ? cents(item.unitPrice) * BigInt(item.quantity) : 0n), 0n);
  const total = subtotal - items.reduce((sum, item) => sum + (numeric.test(item.discount) ? cents(item.discount) : 0n), 0n);
  return <Editor title="New sales order" save="Save draft" onClose={onClose} onSave={async () => {
    onCreated(await send<SalesOrder>('/sales-orders', 'POST', {
      ...form, dueDate: form.dueDate || undefined,
      items: items.map(({ variantId, quantity, unitPrice, discount }) => ({ variantId, quantity: Number(quantity), unitPrice, discount })),
    }));
  }}>
    <div className="form-grid">
      <label>Customer<select required value={form.customerId} onChange={event => setForm({ ...form, customerId: event.target.value })}>
        <option value="">Select customer</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.businessName}</option>)}
      </select></label>
      <label>Order number<input required maxLength={80} value={form.number} onChange={event => setForm({ ...form, number: event.target.value })} /></label>
      <label>Due date (optional)<input type="date" value={form.dueDate} onChange={event => setForm({ ...form, dueDate: event.target.value })} /></label>
      <label className="sales-check"><input type="checkbox" checked={form.reserveStock}
        onChange={event => setForm({ ...form, reserveStock: event.target.checked })} />Reserve stock on confirmation</label>
    </div>
    <h3>Order items</h3>
    {items.map(item => <div className="purchase-line sales-line" key={item.key}>
      <label>Variant<select required value={item.variantId} onChange={event => change(item.key, { variantId: event.target.value })}>
        <option value="">Select variant</option>{variants.filter(variant => !items.some(other => other.key !== item.key && other.variantId === variant.id))
          .map(variant => <option key={variant.id} value={variant.id}>{variantLabel(variant)}</option>)}
      </select></label>
      <label>Quantity<input required type="number" min="1" max="2147483647" value={item.quantity}
        onChange={event => change(item.key, { quantity: event.target.value })} /></label>
      <label>Unit price (PKR)<input required type="number" min="0" max="9999999999.99" step="0.01" value={item.unitPrice}
        onChange={event => change(item.key, { unitPrice: event.target.value })} /></label>
      <label>Line discount (PKR)<input required type="number" min="0" step="0.01" value={item.discount}
        onChange={event => change(item.key, { discount: event.target.value })} /></label>
      {items.length > 1 && <button className="textbtn" type="button" onClick={() => setItems(items.filter(line => line.key !== item.key))}>Remove</button>}
    </div>)}
    <button className="textbtn" type="button" disabled={items.length >= Math.min(variants.length, 100)} onClick={() => {
      setItems([...items, newItem(nextKey)]); setNextKey(nextKey + 1);
    }}>Add item</button>
    <p className="note">Subtotal {price(subtotal)} · Total {price(total)}</p>
  </Editor>;
}

const actionLabels = { confirm: 'Confirm order', cancel: 'Cancel order', dispatches: 'Post dispatch', payments: 'Post payment', returns: 'Post return' };

function PostingEditor({ order, action, onClose, onPosted }: {
  order: SalesOrder; action: Action; onClose: () => void; onPosted: () => void;
}) {
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState(order.customerName);
  const [money, setMoney] = useState('');
  const [method, setMethod] = useState<Method>('CASH');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [conditions, setConditions] = useState<Record<string, 'SALEABLE' | 'DAMAGED'>>({});
  const [requestKey] = useState(() => crypto.randomUUID());
  const confirm = action === 'confirm';
  const cancel = action === 'cancel';
  const dispatching = action === 'dispatches';
  const returning = action === 'returns';
  const paying = action === 'payments';
  const remaining = (item: Item) => dispatching ? item.quantity - item.dispatched : item.dispatched - item.returned;
  const candidates = order.items.filter(item => remaining(item) > 0);

  return <Editor title={actionLabels[action] + ' · ' + order.number} save={actionLabels[action]} onClose={onClose} onSave={async () => {
    const path = '/sales-orders/' + order.id + '/' + action;
    if (confirm || cancel) await send(path, 'POST');
    else if (paying) await send(path, 'POST', { reference, requestKey, amount: money, method });
    else {
      const lines = candidates.map(item => ({ itemId: item.id, quantity: Number(quantities[item.id] || 0) })).filter(line => line.quantity > 0);
      if (!lines.length) throw new Error('Enter a quantity for at least one item.');
      if (dispatching) await send(path, 'POST', { reference, requestKey, destination, lines });
      else {
        await api(path, { method: 'POST', body: JSON.stringify({
          reference, requestKey, reason,
          lines: lines.map(line => ({ ...line, condition: conditions[line.itemId] ?? 'SALEABLE' })),
        }) });
      }
    }
    onPosted();
  }}>
    {confirm && <p>{order.reserveStock ? 'Confirmation reserves the ordered quantities.' : 'This order is configured without stock reservation.'} Physical stock is deducted at dispatch.</p>}
    {cancel && <p>Cancel the unshipped units and release their reservations? Posted dispatches, invoices, and payments will remain in the order history.</p>}
    {!confirm && !cancel && <div className="form-grid">
      <label>Reference<input required maxLength={80} value={reference} onChange={event => setReference(event.target.value)} /></label>
      {dispatching && <label>Destination<input required maxLength={500} value={destination} onChange={event => setDestination(event.target.value)} /></label>}
      {paying && <>
        <label>Amount (PKR)<input required type="number" min="0.01" step="0.01" value={money} onChange={event => setMoney(event.target.value)} /></label>
        <label>Payment method<select value={method} onChange={event => setMethod(event.target.value as Method)}>
          {Object.entries(methods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
      </>}
      {returning && <>
        <label>Reason<input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      </>}
    </div>}
    {paying && <p className="note">Balance due {price(due(order))}</p>}
    {dispatching && <button type="button" className="textbtn fill-receipt" onClick={() => setQuantities(Object.fromEntries(
      candidates.map(item => [item.id, String(remaining(item))]),
    ))}>Fill outstanding quantities</button>}
    {(returning || dispatching) && <div className="form-grid">
      {candidates.map(item => <div key={item.id}>
        <label>{item.variantSku} ({remaining(item)} available)
          <input type="number" min="0" max={remaining(item)} value={quantities[item.id] ?? '0'}
            onChange={event => setQuantities({ ...quantities, [item.id]: event.target.value })} />
        </label>
        {returning && <label>Condition<select value={conditions[item.id] ?? 'SALEABLE'}
          onChange={event => setConditions({ ...conditions, [item.id]: event.target.value as 'SALEABLE' | 'DAMAGED' })}>
          <option value="SALEABLE">Saleable</option><option value="DAMAGED">Damaged</option>
        </select></label>}
      </div>)}
    </div>}
  </Editor>;
}

function RefundEditor({ order, entry, onClose, onSaved }: { order: SalesOrder; entry: Return; onClose: () => void; onSaved: () => void }) {
  const remaining = refundDue(entry);
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState((remaining / 100n).toString() + '.' + (remaining % 100n).toString().padStart(2,'0'));
  const [method, setMethod] = useState<Method>('CASH');
  const [requestKey] = useState(() => crypto.randomUUID());
  return <Editor title="Record refund settlement" save="Record settlement" onClose={onClose} onSave={async () => {
    await send('/sales-orders/' + order.id + '/returns/' + entry.id + '/settlements', 'POST', { reference, amount, method, requestKey });
    onSaved();
  }}>
    <p className="hint">Record the settlement after handing over cash or confirming the bank transfer. {price(remaining)} remains due.</p>
    <div className="form-grid">
      <label>Settlement reference<input required maxLength={80} value={reference} onChange={e=>setReference(e.target.value)} /></label>
      <label>Refund amount (PKR)<input required type="number" step="0.01" min="0.01" value={amount} onChange={e=>setAmount(e.target.value)} /></label>
      <label>Refund method<select value={method} onChange={e=>setMethod(e.target.value as Method)}>
        {Object.entries(methods).map(([key,label])=><option key={key} value={key}>{label}</option>)}
      </select></label>
    </div>
  </Editor>;
}

type ProductMargin = { id: string; name: string; quantity: number; stock: number; sales: string; soldCost: string; grossProfit: string };
type Stats = { totalSales: string; soldQuantity: number; pendingPayments: string; pendingRefunds: string;
  soldCost: string; grossProfit: string; estimatedCost: boolean; stockIn: number; stockOut: number; damaged: number; damageCostEstimate: string;
  topProducts: ProductMargin[]; productMargins?: ProductMargin[];
  recent: (Dispatch & { order: { customerName: string; number: string } })[] };

export function SalesDashboard({ revision, withMargins = false }: { revision: number; withMargins?: boolean }) {
  const [filters, setFilters] = useState(emptyFilters);
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (withMargins) params.set('includeMargins', 'true');
  const query = useQuery<Stats | null>('/sales-dashboard?' + params, null, revision);
  const stats = query.data;
  const loss = stats ? cents(stats.grossProfit) < 0n : false;
  const MarginIcon = loss ? TrendingDown : TrendingUp;
  return <section className="panel warehouse-panel sales-overview" aria-labelledby="sales-overview-title">
    <div className="sales-overview-heading">
      <div><h2 id="sales-overview-title">Sales overview</h2><p>Posted dispatches, returns and stock movements</p></div>
      <div className="sales-period-filter"><ListFilters searchable={false} dateLabel="Reporting period" onApply={setFilters} /></div>
    </div>
    <QueryStatus {...query} />
    {stats && !query.loading && !query.error && <>
      <div className="sales-headline-metrics">
        <article className="sales-headline-card sales-headline-primary">
          <span className="sales-metric-icon"><ReceiptText size={18} aria-hidden="true" /></span>
          <div><h3>Net sales</h3><strong>{price(stats.totalSales)}</strong><p>{stats.soldQuantity.toLocaleString()} units sold after returns</p></div>
        </article>
        <article className={'sales-headline-card' + (loss ? ' sales-headline-loss' : '')}>
          <span className="sales-metric-icon"><MarginIcon size={18} aria-hidden="true" /></span>
          <div><h3>{loss ? 'Gross loss' : 'Gross profit'}</h3><strong>{price(stats.grossProfit)}</strong><p>After cost of goods sold</p></div>
        </article>
        <article className="sales-headline-card">
          <span className="sales-metric-icon"><Wallet size={18} aria-hidden="true" /></span>
          <div><h3>Pending payments</h3><strong>{price(stats.pendingPayments)}</strong><p>All dates · {price(stats.pendingRefunds)} refunds payable</p></div>
        </article>
      </div>
      <div className="sales-secondary-metrics">
        <section className="sales-metric-group">
          <h3><Package size={16} aria-hidden="true" /> Stock movement</h3>
          <dl><div><dt><ArrowDownLeft size={14} aria-hidden="true" /> Stock in</dt><dd>{stats.stockIn.toLocaleString()} units</dd></div>
            <div><dt><ArrowUpRight size={14} aria-hidden="true" /> Stock out</dt><dd>{stats.stockOut.toLocaleString()} units</dd></div></dl>
        </section>
        <section className="sales-metric-group">
          <h3><CalendarDays size={16} aria-hidden="true" /> Costs in this period</h3>
          <dl><div><dt>Cost of goods sold</dt><dd>{price(stats.soldCost)}</dd></div>
            <div><dt>Damage write-offs <small>{stats.damaged.toLocaleString()} units</small></dt><dd>{price(stats.damageCostEstimate)}<small>Estimated cost</small></dd></div></dl>
        </section>
      </div>
      {stats.estimatedCost && <p className="hint">Older sales without a recorded cost snapshot use the current catalogue cost.</p>}
      <p className="sales-metric-note">Gross profit excludes tax, overhead and separate warehouse damage write-offs.</p>
      <div className="sales-activity">
        <section><h3>Top-selling products</h3>{stats.topProducts.length ? <ul>{stats.topProducts.map(product =>
          <li key={product.id}><div><strong>{product.name}</strong><small>{product.quantity.toLocaleString()} sold · {product.stock.toLocaleString()} on hand</small>
            <small>{price(product.grossProfit)} gross profit</small></div><b>{price(product.sales)}</b></li>,
        )}</ul> : <p className="hint">No net sales yet.</p>}</section>
        <section><h3>Recent sales</h3>{stats.recent.length ? <ul>{stats.recent.map(item =>
          <li key={item.id}><div><strong>{item.order.number}</strong><small>{item.order.customerName} · {day(item.createdAt)}</small></div><b>{price(item.total)}</b></li>,
        )}</ul> : <p className="hint">No dispatches yet.</p>}</section>
      </div>
      {stats.productMargins && <ProductMargins items={stats.productMargins} />}
    </>}
  </section>;
}

function ProductMargins({ items }: { items: ProductMargin[] }) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState('');
  const [page, setPage] = useState(1);
  const filtered = items.filter(item => item.name.toLowerCase().includes(search.toLowerCase()) &&
    (!result || (result === 'loss' ? cents(item.grossProfit) < 0n : cents(item.grossProfit) > 0n)));
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const current = Math.min(page, pages);
  return <>
    <h3>Product profit and loss</h3>
    <form className="warehouse-filters list-filters" onSubmit={event => {
      event.preventDefault();
      setSearch(draft.trim()); setPage(1);
    }}>
      <label>Find product margin<input value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <label>Margin result<select value={result} onChange={event => { setResult(event.target.value); setPage(1); }}>
        <option value="">Profit and loss</option><option value="profit">Gross profit only</option><option value="loss">Gross loss only</option>
      </select></label>
      <div className="list-filter-actions"><button className="primary">Search</button></div>
    </form>
    <div className="table-scroll"><table>
      <thead><tr><th>Product</th><th>Net units sold</th><th>On hand now</th><th>Net sales</th><th>Cost of goods sold</th><th>Gross profit / loss</th></tr></thead>
      <tbody>{filtered.slice((current - 1) * 10, current * 10).map(item => <tr key={item.id}>
        <td>{item.name}</td><td>{item.quantity}</td><td>{item.stock}</td><td>{price(item.sales)}</td><td>{price(item.soldCost)}</td>
        <td><span className={'status ' + (cents(item.grossProfit) < 0n ? 'warning' : 'healthy')}>{price(item.grossProfit)}</span></td>
      </tr>)}</tbody>
    </table></div>
    {!filtered.length && <p className="empty">No products match this margin filter.</p>}
    {pages > 1 && <div className="actions">
      <button disabled={current === 1} onClick={() => setPage(current - 1)}>Previous</button>
      <span className="hint">Page {current} of {pages}</span>
      <button disabled={current === pages} onClick={() => setPage(current + 1)}>Next</button>
    </div>}
  </>;
}

export function FinancialReports({ revision }: { revision: number }) {
  const query = useQuery<SalesOrder[]>('/sales-orders', [], revision);
  const [filters, setFilters] = useState(emptyFilters);
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const matches = query.data.filter(order => cents(order.billed) > 0n && matchesFilters(filters,order.createdAt,order.number,order.customerName));
  if (sort === 'due') matches.sort((left, right) => left.dueDate.localeCompare(right.dueDate));
  if (sort === 'balance') matches.sort((left, right) => due(right) > due(left) ? 1 : due(right) < due(left) ? -1 : 0);
  const pages = Math.max(1, Math.ceil(matches.length / 25));
  const currentPage = Math.min(page, pages);
  const totals = matches.reduce((sum, order) => ({
    sales: sum.sales + cents(order.billed) - cents(order.credited),
    collected: sum.collected + cents(order.paid) - cents(order.refunded),
    pending: sum.pending + due(order),
  }), { sales: 0n, collected: 0n, pending: 0n });
  return <>
    <PricingPanel revision={revision} />
    <section className="panel warehouse-panel">
      <div className="panel-head"><div><h2>Sales reconciliation</h2><p>Posted invoices, payments and returns by order</p></div></div>
      <ListFilters label="Order or customer" dateLabel="Sales order created" onApply={value=>{setFilters(value);setPage(1)}}>
        <label>Sort report<select value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}>
          <option value="newest">Newest order</option><option value="due">Earliest due date</option><option value="balance">Highest balance</option>
        </select></label>
      </ListFilters>
      <QueryStatus {...query} />
      {!query.loading && !query.error && <>
        <div className="warehouse-filters sales-totals">
          <div><small>Net invoiced sales</small><b>{price(totals.sales)}</b></div>
          <div><small>Net payments recorded</small><b>{price(totals.collected)}</b></div>
          <div><small>Balance due</small><b>{price(totals.pending)}</b></div>
        </div>
        <div className="table-scroll"><table><thead><tr><th>Order</th><th>Customer</th><th>Invoiced</th><th>Credits</th><th>Payments</th><th>Refunds recorded</th><th>Balance</th><th>Due</th></tr></thead>
        <tbody>{matches.slice((currentPage - 1) * 25, currentPage * 25).map(order => <tr key={order.id}>
          <td>{order.number}</td><td>{order.customerName}</td><td>{price(order.billed)}</td><td>{price(order.credited)}</td>
          <td>{price(order.paid)}</td><td>{price(order.refunded)}</td><td>{price(due(order))}</td><td>{day(order.dueDate)}</td>
        </tr>)}</tbody></table></div>
        {!matches.length && <p className="empty">No matching posted invoices.</p>}
        {pages > 1 && <div className="actions">
          <button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
          <span className="hint">Page {currentPage} of {pages}</span>
          <button disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</button>
        </div>}
      </>}
    </section>
    <SalesDashboard revision={revision} withMargins />
  </>;
}
