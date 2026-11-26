import { useState } from 'react';
import { formatProductPrice, QueryStatus, useQuery } from './warehouse-ui';

type Item = { id: string; name: string; sku: string; costPrice: string; salePrice: string };

function minorUnits(text: string) {
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function display(value: bigint) {
  const absolute = value < 0n ? -value : value;
  return (value < 0n ? '−' : '') + 'PKR ' + (absolute / 100n).toLocaleString('en-PK') + '.' + (absolute % 100n).toString().padStart(2, '0');
}

export function PricingPanel({ revision }: { revision: number }) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [salePrice, setSalePrice] = useState('');
  const [taxRate, setTaxRate] = useState('0');
  const results = useQuery<{ items: Item[] }>('/products?page=1&search=' + encodeURIComponent(search), { items: [] }, revision);
  const product = results.data.items.find(item => item.id === productId);
  const cost = product ? minorUnits(product.costPrice) : null;
  const rate = minorUnits(taxRate);
  const price = minorUnits(salePrice);
  const units = /^\d{1,7}$/.test(quantity) && Number(quantity) > 0 ? BigInt(quantity) : null;
  const subtotal = price !== null && units !== null ? price * units : null;
  const tax = subtotal !== null && rate !== null && rate <= 10000n ? (subtotal * rate + 5000n) / 10000n : null;
  const profit = subtotal !== null && cost !== null && units !== null ? subtotal - cost * units : null;

  return <section className="panel warehouse-panel">
    <div className="panel-head"><div><h2>Product pricing and tax estimate</h2><p>Tax estimate uses the entered rate. It is separate from posted invoices.</p></div></div>
    <form className="warehouse-filters list-filters" onSubmit={event => {
      event.preventDefault();
      setSearch(draft.trim());
    }}>
      <label>Find product by name or SKU<input maxLength={100} value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <div className="list-filter-actions"><button className="primary">Search</button></div>
    </form>
    <QueryStatus {...results} />
    <div className="warehouse-filters">
      <label>Product<select value={product?.id ?? ''} onChange={event => {
        const item = results.data.items.find(row => row.id === event.target.value);
        setProductId(item?.id ?? ''); setSalePrice(item?.salePrice ?? '');
      }}>
        <option value="">Select a product</option>
        {results.data.items.map(item => <option key={item.id} value={item.id}>{item.name} ({item.sku})</option>)}
      </select></label>
      <label>Quantity<input type="number" min="1" step="1" max="9999999" value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
      <label>Selling price per unit (PKR)<input type="number" min="0" step="0.01" value={salePrice} onChange={event => setSalePrice(event.target.value)} /></label>
      <label>Tax rate (%)<input type="number" min="0" max="100" step="0.01" value={taxRate} onChange={event => setTaxRate(event.target.value)} /></label>
    </div>
    {product && <div className="warehouse-filters sales-totals">
      <div><small>Catalogue cost per unit</small><b>{formatProductPrice(product.costPrice)}</b></div>
      <div><small>Subtotal before tax</small><b>{subtotal === null ? '—' : display(subtotal)}</b></div>
      <div><small>Estimated tax</small><b>{tax === null ? '—' : display(tax)}</b></div>
      <div><small>Total including estimated tax</small><b>{subtotal === null || tax === null ? '—' : display(subtotal + tax)}</b></div>
      <div><small>{profit !== null && profit < 0n ? 'Estimated gross loss' : 'Estimated gross profit'}</small><b>{profit === null ? '—' : display(profit)}</b></div>
    </div>}
  </section>;
}
