import { ListFilters, emptyFilters, matchesFilters } from './ListFilters';
import { useState } from 'react';
import { base, send } from './api';
import { Editor, formatProductPrice, QueryStatus, useQuery, variantLabel, type StockVariant } from './warehouse-ui';

const types = {
  OPENING: 'Opening balance', RECEIPT: 'Purchase receipt', STOCK_IN: 'Stock in', STOCK_OUT: 'Stock out',
  RETURN_IN: 'Customer return', RETURN_TO_SUPPLIER: 'Return to supplier', DAMAGE: 'Damage', ADJUSTMENT: 'Adjustment',
};
type MovementType = keyof typeof types;
const manualTypes = ['STOCK_IN', 'STOCK_OUT', 'RETURN_IN', 'RETURN_TO_SUPPLIER', 'DAMAGE', 'ADJUSTMENT'] as const;
type Movement = {
  id: string; type: MovementType; quantity: number; balanceAfter: number; createdAt: string;
  reason: string | null; destination: string | null; reference: string | null; variant: StockVariant;
};
type Product = { id: string; name: string; sku: string };

export default function Inventory({ onStockChange, allowUnlinkedReturns }: { onStockChange: () => void; allowUnlinkedReturns: boolean }) {
  const [revision, setRevision] = useState(0);
  const [filters, setFilters] = useState({ productId: '', variantId: '', type: '', ...emptyFilters });
  const [stockFilters,setStockFilters] = useState(emptyFilters);
  const [stockStatus,setStockStatus] = useState('');
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<'movement' | 'variant' | null>(null);
  const [threshold, setThreshold] = useState<StockVariant | null>(null);
  const [point, setPoint] = useState('');
  const variants = useQuery<StockVariant[]>('/inventory/variants', [], revision);
  const visibleStock = variants.data.filter(variant => {
    const low = variant.availableQty <= variant.reorderPoint;
    return (!stockStatus || (stockStatus === "low" ? low : !low)) && matchesFilters(stockFilters,variant.product.createdAt,variant.product.name,variant.product.sku,variant.sku,variant.size,variant.color,String(variant.product.serialNumber));
  });
  const products = [...new Map(variants.data.map(variant => [variant.productId, variant.product])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  const matchingVariants = variants.data.filter(variant => !filters.productId || variant.productId === filters.productId);
  const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  const history = useQuery<{ items: Movement[]; total: number; page: number }>(
    '/inventory/history?' + params.toString() + '&page=' + page, { items: [], total: 0, page: 1 }, revision,
  );
  const maxPage = Math.max(1, Math.ceil(history.data.total / 50));

  function updateFilters(changes: Partial<typeof filters>) {
    setFilters({ ...filters, ...changes });
    setPage(1);
  }

  function refresh() {
    setRevision(previous => previous + 1);
    setPage(1);
    onStockChange();
  }

  return <>
    <section className="panel warehouse-panel">
      <div className="panel-head"><h2>Variant stock</h2><div className="warehouse-actions">
        <button className="textbtn" disabled={!products.some(product => !product.archived)} onClick={() => setEditor('variant')}>Add variant</button>
        <button className="primary" disabled={!variants.data.length} onClick={() => setEditor('movement')}>Record movement</button>
      </div></div>
      <ListFilters label="Find stock, size or color" dateLabel="Product created" onApply={setStockFilters}><label>Stock status<select value={stockStatus} onChange={event=>setStockStatus(event.target.value)}><option value="">All stock</option><option value="low">Low stock</option><option value="available">Available</option></select></label></ListFilters>
      <QueryStatus {...variants} />
      <div className="table-scroll"><table className="stock-table"><thead><tr><th>Product</th><th>Category serial</th><th>SKU</th><th>Selling price</th><th>Size</th><th>Color</th><th>On hand</th><th>Reserved</th><th>Unreserved</th><th>Reorder at</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{visibleStock.map(variant => <tr key={variant.id}>
          <td><div className="stock-product">{variant.product.image?<img className="product-thumbnail" loading="lazy" src={base+"/products/"+variant.product.id+"/image"} alt=""/>:<span className="stock-no-photo" aria-hidden="true">—</span>}<div><b>{variant.product.name}</b>{variant.product.archived && <small>Archived</small>}</div></div></td>
          <td>{variant.product.serialNumber}</td><td className="mono">{variant.sku}</td><td>{formatProductPrice(variant.product.salePrice)}</td><td>{variant.size}</td><td>{variant.color}</td><td>{variant.availableQty}</td><td>{variant.reservedQty}</td><td>{variant.availableQty - variant.reservedQty}</td>
          <td>{variant.reorderPoint}</td>
          <td><span className={'status ' + (variant.availableQty <= variant.reorderPoint ? 'warning' : 'healthy')}>
            {variant.availableQty === 0 ? 'Coming Soon' : variant.availableQty <= variant.reorderPoint ? 'Low stock' : 'Available'}</span></td>
          <td className="table-action"><button className="textbtn detail-link" onClick={() => { setThreshold(variant); setPoint(String(variant.reorderPoint)); }}>Edit threshold</button></td>
        </tr>)}</tbody>
      </table></div>
      {!variants.loading && !visibleStock.length && <p className="empty">No matching stock variants.</p>}
    </section>
    <section className="panel warehouse-panel">
      <div className="panel-head"><h2>Stock history</h2>
        <a className="primary" href={base + '/inventory/history.csv?' + params.toString()}>Export CSV</a>
      </div>
      <ListFilters label="Find movements or references" dateLabel="Movement posted" onApply={updateFilters}>
        <label>Product<select value={filters.productId} onChange={event => updateFilters({ productId: event.target.value, variantId: '' })}>
          <option value="">All products</option>{products.map(product => <option key={product.id} value={product.id}>{product.name} ({product.sku})</option>)}
        </select></label>
        <label>Variant<select value={filters.variantId} onChange={event => updateFilters({ variantId: event.target.value })}>
          <option value="">All variants</option>{matchingVariants.map(variant => <option key={variant.id} value={variant.id}>{variantLabel(variant)}</option>)}
        </select></label>
        <label>Movement type<select value={filters.type} onChange={event => updateFilters({ type: event.target.value })}>
          <option value="">All movements</option>{Object.entries(types).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select></label>
      </ListFilters>
      <QueryStatus {...history} />
      <div className="table-scroll"><table><thead><tr>
        <th>Time (UTC)</th><th>Product / variant</th><th>Movement</th><th>Change</th><th>Balance</th><th>Reason</th><th>Destination</th><th>Reference</th>
      </tr></thead><tbody>{!history.error && history.data.items.map(item => <tr key={item.id}>
        <td>{item.createdAt.slice(0, 19).replace('T', ' ')}</td><td>{variantLabel(item.variant)}</td><td>{types[item.type]}</td>
        <td>{item.quantity > 0 ? '+' : ''}{item.quantity}</td><td>{item.balanceAfter}</td><td>{item.reason ?? '—'}</td>
        <td>{item.destination ?? '—'}</td><td>{item.reference ?? '—'}</td>
      </tr>)}</tbody></table></div>
      {!history.loading && !history.error && !history.data.items.length && <p className="empty">No matching stock movements.</p>}
      {maxPage > 1 && <div className="actions">
        <button disabled={history.loading || page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="hint">Page {page} of {maxPage}</span>
        <button disabled={history.loading || page >= maxPage} onClick={() => setPage(page + 1)}>Next</button>
      </div>}
    </section>
    {editor === 'movement' && <MovementEditor variants={variants.data} allowUnlinkedReturns={allowUnlinkedReturns} onClose={() => setEditor(null)} onSaved={refresh} />}
    {editor === 'variant' && <VariantEditor products={products.filter(product => !product.archived)} onClose={() => setEditor(null)} onSaved={refresh} />}
    {threshold && <Editor title={'Low-stock threshold for ' + threshold.sku} onClose={() => setThreshold(null)} onSave={async () => {
      await send('/inventory/variants/' + threshold.id, 'PATCH', { reorderPoint: Number(point) });
      refresh();
    }}><label>Threshold<input required type="number" min="0" max="2147483647" value={point} onChange={event => setPoint(event.target.value)} /></label></Editor>}
  </>;
}

function MovementEditor({ variants, onClose, onSaved, allowUnlinkedReturns }: { variants: StockVariant[]; onClose: () => void; onSaved: () => void; allowUnlinkedReturns: boolean }) {
  const [variantId, setVariantId] = useState('');
  const [type, setType] = useState<typeof manualTypes[number]>('STOCK_IN');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState('');
  const [reference, setReference] = useState('');
  const [requestKey] = useState(() => crypto.randomUUID());
  const needsDestination = type === 'STOCK_OUT' || type === 'RETURN_TO_SUPPLIER';

  return <Editor title="Record stock movement" save="Post movement" onClose={onClose} onSave={async () => {
    await send('/inventory/movements', 'POST', {
      variantId, type, quantity: Number(quantity), reason, reference, requestKey,
      destination: destination.trim() || undefined,
    });
    onSaved();
  }}>
    <div className="form-grid">
      <label>Variant<select required value={variantId} onChange={event => setVariantId(event.target.value)}>
        <option value="">Choose variant</option>{variants.map(variant => <option key={variant.id} value={variant.id}>{variantLabel(variant)} · {variant.availableQty} available</option>)}
      </select></label>
      <label>Movement type<select value={type} onChange={event => {
        const next = event.target.value as typeof type;
        setType(next);
        if (next !== 'ADJUSTMENT' && Number(quantity) < 1) setQuantity('1');
      }}>
        {manualTypes.filter(value => value !== 'RETURN_IN' || allowUnlinkedReturns).map(value =>
          <option key={value} value={value}>{value === 'RETURN_IN' ? 'Unlinked stock return' : types[value]}</option>)}
      </select></label>
      <label>{type === 'ADJUSTMENT' ? 'Quantity change (+ / −)' : 'Quantity'}<input required type="number"
        min={type === 'ADJUSTMENT' ? '-2147483647' : '1'} max="2147483647" value={quantity}
        onChange={event => setQuantity(event.target.value)} /></label>
      <label>Reference<input required maxLength={80} value={reference} onChange={event => setReference(event.target.value)} /></label>
      <label>Reason<input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <label>Destination<input required={needsDestination} maxLength={500} value={destination} onChange={event => setDestination(event.target.value)} /></label>
    </div>
  </Editor>;
}

function VariantEditor({ products, onClose, onSaved }: { products: Product[]; onClose: () => void; onSaved: () => void }) {
  const [fields, setFields] = useState({ productId: '', sku: '', size: '', color: '', reorderPoint: '5' });
  return <Editor title="Add product variant" onClose={onClose} onSave={async () => {
    await send('/inventory/variants', 'POST', { ...fields, reorderPoint: Number(fields.reorderPoint) });
    onSaved();
  }}>
    <div className="form-grid">
      <label>Product<select required value={fields.productId} onChange={event => setFields({ ...fields, productId: event.target.value })}>
        <option value="">Choose product</option>{products.map(product => <option key={product.id} value={product.id}>{product.name} ({product.sku})</option>)}
      </select></label>
      {([['sku', 'Variant SKU', 80], ['size', 'Size', 40], ['color', 'Color', 40]] as const).map(([field, label, max]) =>
        <label key={field}>{label}<input required maxLength={max} value={fields[field]} onChange={event => setFields({ ...fields, [field]: event.target.value })} /></label>
      )}
      <label>Low-stock threshold<input required type="number" min="0" max="2147483647" value={fields.reorderPoint}
        onChange={event => setFields({ ...fields, reorderPoint: event.target.value })} /></label>
    </div>
  </Editor>;
}
