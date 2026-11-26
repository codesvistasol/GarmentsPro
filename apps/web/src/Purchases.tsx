import { ListFilters, emptyFilters, matchesFilters } from './ListFilters';
import { useState } from 'react';
import { base, send } from './api';
import { Editor, QueryStatus, useOrderDetails, useQuery, variantLabel, type StockVariant } from './warehouse-ui';
import type { Supplier } from './Suppliers';

type PurchaseItem = {
  id: string; variantSku: string; productName: string; size: string; color: string;
  quantity: number; receivedQty: number; unitPrice: string;
};
type Receipt = { id: string; reference: string; receivedAt: string; lines: { id: string; itemId: string; quantity: number }[] };
type Order = { id: string; supplierName: string; reference: string; orderDate: string; items: PurchaseItem[]; receipts: Receipt[] };
type Draft = { key: number; variantId: string; quantity: string; unitPrice: string };
const newLine = (key: number): Draft => ({ key, variantId: '', quantity: '1', unitPrice: '' });
function minorUnits(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function price(cents: bigint) {
  return 'PKR ' + (cents / 100n).toLocaleString('en-PK') + '.' + (cents % 100n).toString().padStart(2, '0');
}
const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export default function Purchases({ onStockChange }: { onStockChange: () => void }) {
  const [revision, setRevision] = useState(0);
  const orders = useQuery<Order[]>('/purchase-orders', [], revision);
  const [filters,setFilters] = useState(emptyFilters);
  const [receiptStatus,setReceiptStatus] = useState('');
  const visibleOrders = orders.data.filter(order => {
    const received = order.items.some(item => item.receivedQty > 0);
    const complete = order.items.every(item => item.receivedQty === item.quantity);
    const status = complete ? 'Received' : received ? 'Partial' : 'Open';
    return (!receiptStatus || receiptStatus === status) && matchesFilters(filters, order.orderDate, order.reference, order.supplierName, ...order.items.flatMap(item => [item.productName,item.variantSku]));
  });
  const suppliers = useQuery<Supplier[]>('/suppliers', []);
  const variants = useQuery<StockVariant[]>('/inventory/variants', []);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState('');
  const [receiving, setReceiving] = useState(false);
  const [receiptId, setReceiptId] = useState('');
  const order = orders.data.find(item => item.id === selected);
  const { details, reveal } = useOrderDetails(order?.id ?? '');
  const receipt = order?.receipts.find(item => item.id === receiptId);
  const reload = () => setRevision(previous => previous + 1);
  const canCreate = suppliers.data.some(supplier => supplier.active) && variants.data.some(variant => !variant.product.archived);

  return <>
    <section className="panel warehouse-panel purchase-orders">
      <div className="panel-head"><h2>Purchase orders</h2><div className="warehouse-actions">
        <a className="textbtn" href={base + '/purchase-orders.csv'}>Export orders CSV</a>
        <button className="primary" disabled={!canCreate} onClick={() => setCreating(true)}>New purchase order</button></div>
      </div>
      <ListFilters label="Find purchase orders" dateLabel="Purchase order date" onApply={setFilters}><label>Receipt status<select value={receiptStatus} onChange={event=>setReceiptStatus(event.target.value)}><option value="">All statuses</option><option>Open</option><option>Partial</option><option>Received</option></select></label></ListFilters>
      <QueryStatus loading={orders.loading || suppliers.loading || variants.loading} error={orders.error || suppliers.error || variants.error} />
      {!canCreate && !suppliers.loading && !variants.loading && <p className="hint">An active supplier and a product variant are required to create an order.</p>}
      <div className="table-scroll"><table className="order-list-table purchase-list"><thead><tr><th>Reference</th><th>Supplier</th><th>Order date</th><th>Received</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{visibleOrders.map(item => {
          const ordered = item.items.reduce((total, line) => total + line.quantity, 0);
          const received = item.items.reduce((total, line) => total + line.receivedQty, 0);
          const status = received === ordered ? 'Received' : received ? 'Partial' : 'Open';
          return <tr key={item.id}><td><b>{item.reference}</b></td><td>{item.supplierName}</td><td>{item.orderDate.slice(0, 10)}</td>
            <td>{received} / {ordered}</td><td><span className={'status ' + (status === 'Received' ? 'healthy' : 'warning')}>{status}</span></td>
            <td className="table-action"><button className="textbtn detail-link" onClick={() => { if (selected === item.id) reveal(); else setSelected(item.id); setReceiptId(''); }}>View order</button></td></tr>;
        })}</tbody>
      </table></div>
      {!orders.loading && !visibleOrders.length && <p className="empty">No matching purchase orders.</p>}
    </section>
    {order && <section className="panel warehouse-panel purchase-orders order-detail" ref={details} tabIndex={-1} aria-label="Purchase order details">
      <div className="panel-head"><div><h2>Order {order.reference}</h2><p>{order.supplierName} · {order.orderDate.slice(0, 10)}</p></div>
        <div className="warehouse-actions">{order.items.some(item => item.receivedQty < item.quantity) && <button className="primary" onClick={() => setReceiving(true)}>Receive goods</button>}<button className="textbtn" onClick={() => { setSelected(''); setReceiptId(''); }}>Close details</button></div>
      </div>
      <div className="table-scroll"><table><thead><tr><th>Product</th><th>Variant</th><th>Unit price</th><th>Ordered</th><th>Received</th><th>Outstanding</th></tr></thead>
        <tbody>{order.items.map(item => <tr key={item.id}><td>{item.productName}</td><td>{item.variantSku} · {item.color} / {item.size}</td>
          <td>{price(minorUnits(item.unitPrice))}</td><td>{item.quantity}</td><td>{item.receivedQty}</td><td>{item.quantity - item.receivedQty}</td></tr>)}</tbody>
      </table></div>
      <h3>Goods receipts</h3>
      {order.receipts.length ? <ul className="receipt-list">{order.receipts.map(item => <li key={item.id}>
        <button className="textbtn" onClick={() => setReceiptId(item.id)}>View receipt {item.reference}</button>
      </li>)}</ul> : <p className="hint">No goods received yet.</p>}
    </section>}
    {order && receipt && <PrintReceipt order={order} receipt={receipt} />}
    {creating && <OrderEditor suppliers={suppliers.data.filter(supplier => supplier.active)}
      variants={variants.data.filter(variant => !variant.product.archived)} onClose={() => setCreating(false)}
      onCreated={item => { setSelected(item.id); setReceiptId(''); reload(); }} />}
    {order && receiving && <ReceiptEditor order={order} onClose={() => setReceiving(false)} onReceived={item => {
      setReceiptId(item.id); reload(); onStockChange();
    }} />}
  </>;
}

function OrderEditor({ suppliers, variants, onClose, onCreated }: {
  suppliers: Supplier[]; variants: StockVariant[]; onClose: () => void; onCreated: (order: Order) => void;
}) {
  const [fields, setFields] = useState({ supplierId: '', reference: '', orderDate: today() });
  const [items, setItems] = useState([newLine(1)]);
  const [nextKey, setNextKey] = useState(2);
  const update = (key: number, changes: Partial<Draft>) => setItems(items.map(item => item.key === key ? { ...item, ...changes } : item));

  return <Editor title="New purchase order" save="Create order" onClose={onClose} onSave={async () => {
    onCreated(await send<Order>('/purchase-orders', 'POST', {
      ...fields, items: items.map(({ variantId, quantity, unitPrice }) => ({ variantId, quantity: Number(quantity), unitPrice })),
    }));
  }}>
    <div className="form-grid">
      <label>Supplier<select required value={fields.supplierId} onChange={event => setFields({ ...fields, supplierId: event.target.value })}>
        <option value="">Choose supplier</option>
        {suppliers.map(item => <option key={item.id} value={item.id}>{item.company}</option>)}
      </select></label>
      <label>Order reference<input required maxLength={80} value={fields.reference} onChange={event => setFields({ ...fields, reference: event.target.value })} /></label>
      <label>Order date<input required type="date" value={fields.orderDate} onChange={event => setFields({ ...fields, orderDate: event.target.value })} /></label>
    </div>
    <h3>Items</h3>
    {items.map(item => <div className="purchase-line" key={item.key}>
      <label>Variant<select required value={item.variantId} onChange={event => update(item.key, { variantId: event.target.value })}>
        <option value="">Choose variant</option>
        {variants.filter(variant => !items.some(other => other.key !== item.key && other.variantId === variant.id)).map(variant =>
          <option key={variant.id} value={variant.id}>{variantLabel(variant)}</option>
        )}
      </select></label>
      <label>Quantity<input required type="number" min="1" max="2147483647" value={item.quantity} onChange={event => update(item.key, { quantity: event.target.value })} /></label>
      <label>Unit price (PKR)<input required type="number" min="0" max="9999999999.99" step="0.01" value={item.unitPrice} onChange={event => update(item.key, { unitPrice: event.target.value })} /></label>
      {items.length > 1 && <button className="textbtn" type="button" onClick={() => setItems(items.filter(line => line.key !== item.key))}>Remove</button>}
    </div>)}
    <button type="button" className="textbtn" disabled={items.length >= Math.min(variants.length, 100)} onClick={() => {
      setItems([...items, newLine(nextKey)]); setNextKey(nextKey + 1);
    }}>Add item</button>
  </Editor>;
}

function ReceiptEditor({ order, onClose, onReceived }: { order: Order; onClose: () => void; onReceived: (receipt: Receipt) => void }) {
  const [reference, setReference] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const outstanding = order.items.filter(item => item.receivedQty < item.quantity);
  return <Editor title={'Receive goods for ' + order.reference} save="Post receipt" onClose={onClose} onSave={async () => {
    const lines = outstanding.map(item => ({ itemId: item.id, quantity: Number(quantities[item.id] || 0) })).filter(line => line.quantity > 0);
    if (!lines.length) throw new Error('Enter a received quantity for at least one item.');
    onReceived(await send<Receipt>('/purchase-orders/' + order.id + '/receipts', 'POST', { reference, lines }));
  }}>
    <label>Receipt reference<input required maxLength={80} value={reference} onChange={event => setReference(event.target.value)} /></label>
    <button type="button" className="textbtn fill-receipt" onClick={() => setQuantities(Object.fromEntries(
      outstanding.map(item => [item.id, String(item.quantity - item.receivedQty)]),
    ))}>Fill outstanding quantities</button>
    <div className="form-grid">
      {outstanding.map(item => <label key={item.id}>{item.variantSku} ({item.quantity - item.receivedQty} outstanding)
        <input type="number" min="0" max={item.quantity - item.receivedQty} value={quantities[item.id] ?? '0'}
          onChange={event => setQuantities({ ...quantities, [item.id]: event.target.value })} />
      </label>)}
    </div>
  </Editor>;
}

function PrintReceipt({ order, receipt }: { order: Order; receipt: Receipt }) {
  const itemsById = new Map(order.items.map(item => [item.id, item]));
  const lines = receipt.lines.map(line => {
    const item = itemsById.get(line.itemId)!;
    const unitPrice = minorUnits(item.unitPrice);
    return { ...line, item, unitPrice, total: unitPrice * BigInt(line.quantity) };
  });
  return <section className="panel warehouse-panel print-receipt">
    <div className="panel-head"><div><h2>Goods receipt {receipt.reference}</h2><p>GarmentPro Warehouse Management</p></div>
      <button className="primary no-print" onClick={() => window.print()}>Print receipt</button></div>
    <p>Supplier {order.supplierName} · Order {order.reference} · Received {new Date(receipt.receivedAt).toLocaleString()}</p>
    <div className="table-scroll"><table><thead><tr><th>Product</th><th>Variant</th><th>Quantity</th><th>Unit price</th><th>Amount</th></tr></thead>
      <tbody>{lines.map(({ id, quantity, item, unitPrice, total }) => <tr key={id}><td>{item.productName}</td>
        <td>{item.variantSku} · {item.color} / {item.size}</td><td>{quantity}</td><td>{price(unitPrice)}</td><td>{price(total)}</td></tr>)}</tbody>
      <tfoot><tr><td colSpan={4}><strong>Total received value</strong></td><td>{price(lines.reduce((total, line) => total + line.total, 0n))}</td></tr></tfoot>
    </table></div>
  </section>;
}
