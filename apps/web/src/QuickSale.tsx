import { useState, type FormEvent } from 'react';
import { ArrowUpRight, CheckCircle2, Download, Minus, Plus, ReceiptText, Search, Shirt, Trash2 } from 'lucide-react';
import { base, send } from './api';
import { CategoryOptions, type CategoryNode } from './category-options';
import { formatProductPrice, QueryStatus, useQuery } from './warehouse-ui';

type Variant = { id: string; sku: string; size: string; color: string; availableQty: number; reservedQty: number };
type Product = { id: string; name: string; sku: string; salePrice: string; image?: { productId: string } | null; variants: Variant[] };
type CartLine = { variantId: string; name: string; label: string; price: string; limit: number; quantity: number };
type Customer = { id: string; businessName: string };
type Checkout = {
  id: string;
  number: string;
  customerName: string;
  billed: string;
  paid: string;
  dispatches: { id: string; reference: string }[];
};
type Payment = 'CASH' | 'BANK_TRANSFER' | 'ACCOUNT';

function minorUnits(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function currency(value: bigint) {
  return 'PKR ' + (value / 100n).toLocaleString('en-PK') + '.' + (value % 100n).toString().padStart(2, '0');
}

export default function QuickSale({ categories, revision, onChange }: {
  categories: CategoryNode[]; revision: number; onChange: () => void;
}) {
  const [draftSearch, setDraftSearch] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [destination, setDestination] = useState('Shop counter');
  const [payment, setPayment] = useState<Payment>('CASH');
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState<Checkout | null>(null);
  const params = new URLSearchParams({ search, page: String(page), sort: 'photo' });
  if (category) {
    params.set('categoryId', category);
    params.set('includeChildren', 'true');
  }
  const catalogue = useQuery<{ items: Product[]; total: number }>('/products?' + params, { items: [], total: 0 }, revision);
  const customers = useQuery<Customer[]>('/customers', [], revision);
  const total = cart.reduce((sum, line) => sum + minorUnits(line.price) * BigInt(line.quantity), 0n);
  const pages = Math.max(1, Math.ceil(catalogue.data.total / 25));
  const invoice = complete?.dispatches[0];

  function add(product: Product, variant: Variant) {
    const limit = variant.availableQty - variant.reservedQty;
    if (limit < 1) return;
    setError('');
    setCart(current => {
      const existing = current.find(line => line.variantId === variant.id);
      if (existing) return current.map(line => line === existing
        ? { ...line, price: product.salePrice, limit, quantity: Math.min(limit, line.quantity + 1) }
        : line);
      return [...current, {
        variantId: variant.id, name: product.name, label: [variant.color, variant.size, variant.sku].join(' · '),
        price: product.salePrice, limit, quantity: 1,
      }];
    });
  }

  function adjust(variantId: string, delta: number) {
    setCart(current => current.map(line => line.variantId === variantId
      ? { ...line, quantity: Math.max(1, Math.min(line.limit, line.quantity + delta)) }
      : line));
  }

  async function checkout(event: FormEvent) {
    event.preventDefault();
    if (posting || !cart.length || (payment === 'ACCOUNT' && !customerId)) return;
    setPosting(true);
    setError('');
    try {
      const order = await send<Checkout>('/sales-checkout', 'POST', {
        requestKey, destination, customerId: customerId || undefined,
        paymentMethod: payment === 'ACCOUNT' ? undefined : payment,
        items: cart.map(line => ({ variantId: line.variantId, quantity: line.quantity, unitPrice: line.price })),
      });
      setComplete(order);
      onChange();
    } catch (cause) {
      setError((cause as Error).message);
      onChange();
    } finally {
      setPosting(false);
    }
  }

  function startNextSale() {
    setCart([]); setComplete(null); setCustomerId(''); setPayment('CASH'); setError('');
    setRequestKey(crypto.randomUUID());
  }

  return <div className="checkout-workspace">
    <section className="panel checkout-catalogue" aria-labelledby="checkout-catalogue-title">
      <div className="panel-head"><div><h2 id="checkout-catalogue-title">Choose products</h2><p>Select a size and color to add it to the sale.</p></div>
        <a className="checkout-secondary checkout-jump" href="#checkout-sale-summary"><ReceiptText size={15}/> Sale summary</a>
      </div>
      <form className="warehouse-filters list-filters" onSubmit={event => { event.preventDefault(); setSearch(draftSearch.trim()); setPage(1); }}>
        <label>Find sale products<input value={draftSearch} maxLength={100} onChange={event => setDraftSearch(event.target.value)} placeholder="Name, SKU or serial" /></label>
        <label>Category<select value={category} onChange={event => { setCategory(event.target.value); setPage(1); }}>
          <option value="">All categories</option><CategoryOptions categories={categories} />
        </select></label>
        <div className="list-filter-actions"><button className="primary"><Search size={15} /> Search</button></div>
      </form>
      <QueryStatus {...catalogue} />
      {!catalogue.loading && !catalogue.error && <div className="checkout-grid">
        {catalogue.data.items.map(product => <article className="checkout-product" key={product.id}>
          <div className="checkout-product-photo">
            {product.image ? <img src={base + '/products/' + product.id + '/image'} alt={product.name} loading="lazy" /> : <Shirt size={29} aria-hidden="true" />}
          </div>
          <div className="checkout-product-info"><div><small>{product.sku}</small><h3>{product.name}</h3></div><b>{formatProductPrice(product.salePrice)}</b></div>
          <div className="checkout-variants">
            {product.variants.map(variant => {
              const free = Math.max(0, variant.availableQty - variant.reservedQty);
              const count = cart.find(line => line.variantId === variant.id)?.quantity ?? 0;
              return <button key={variant.id} type="button" disabled={posting || Boolean(complete) || free <= count}
                onClick={() => add(product, variant)} aria-label={'Add ' + product.name + ' ' + variant.color + ' ' + variant.size}>
                <span>{variant.color} / {variant.size}</span><small>{free > 0 ? free + ' available' : variant.availableQty > 0 ? 'Fully reserved' : 'Coming Soon'}</small><Plus size={15} />
              </button>;
            })}
            {!product.variants.length && <small>No sellable variants</small>}
          </div>
        </article>)}
      </div>}
      {!catalogue.loading && !catalogue.error && !catalogue.data.items.length && <p className="empty">No products match your search.</p>}
      {pages > 1 && <div className="actions">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span className="hint">Page {page} of {pages}</span>
        <button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>}
    </section>

    <section className="panel checkout-cart" id="checkout-sale-summary" aria-label="Sale summary">
      {complete && invoice ? <>
        <div className="checkout-success"><CheckCircle2 size={24}/><h2>Invoice ready</h2></div>
        <p className="checkout-reference">{invoice.reference}</p>
        <dl className="checkout-totals"><div><dt>Customer</dt><dd>{complete.customerName}</dd></div>
          <div><dt>Invoice total</dt><dd>{currency(minorUnits(complete.billed))}</dd></div>
          <div><dt>Payment recorded</dt><dd>{currency(minorUnits(complete.paid))}</dd></div>
          <div><dt>Balance due</dt><dd>{currency(minorUnits(complete.billed) - minorUnits(complete.paid))}</dd></div>
        </dl>
        <div className="checkout-invoice-buttons">
          <a className="primary" href={base + '/sales-invoices/' + invoice.id + '.pdf?view=1'} target="_blank" rel="noreferrer">View &amp; print <ArrowUpRight size={15}/></a>
          <a className="checkout-secondary" href={base + '/sales-invoices/' + invoice.id + '.pdf'}><Download size={15}/> Download PDF</a>
        </div>
        <button className="textbtn checkout-next" type="button" onClick={startNextSale}>Start another sale</button>
      </> : <>
        <div className="checkout-cart-heading"><ReceiptText size={20}/><h2>Current sale</h2><span>{cart.reduce((sum, item) => sum + item.quantity, 0)} units</span></div>
        {!cart.length && <p className="checkout-empty">Add a product variant to start the invoice.</p>}
        <ul className="checkout-lines">{cart.map(line => <li key={line.variantId}>
          <div><strong>{line.name}</strong><small>{line.label}</small></div>
          <b>{currency(minorUnits(line.price) * BigInt(line.quantity))}</b>
          <div className="checkout-stepper">
            <button type="button" aria-label={'Decrease ' + line.name} disabled={posting || line.quantity <= 1} onClick={() => adjust(line.variantId, -1)}><Minus size={14}/></button>
            <input type="number" min="1" max={line.limit} step="1" value={line.quantity}
              aria-label={'Quantity for ' + line.name + ' ' + line.label} disabled={posting}
              onChange={event => {
                const next = event.target.valueAsNumber;
                if (Number.isInteger(next)) adjust(line.variantId, next - line.quantity);
              }}/>
            <button type="button" aria-label={'Increase ' + line.name} disabled={posting || line.quantity >= line.limit} onClick={() => adjust(line.variantId, 1)}><Plus size={14}/></button>
          </div>
          <button className="checkout-remove" type="button" aria-label={'Remove ' + line.name} disabled={posting}
            onClick={() => setCart(cart.filter(item => item.variantId !== line.variantId))}><Trash2 size={15}/></button>
        </li>)}</ul>
        <form onSubmit={checkout} className="checkout-form">
          <fieldset disabled={posting}>
            <label>Customer<select value={customerId} onChange={event => setCustomerId(event.target.value)} required={payment === 'ACCOUNT'}>
              <option value="">{payment === 'ACCOUNT' ? 'Select a customer' : 'Walk-in customer'}</option>
              {customers.data.filter(customer => customer.id !== 'garmentpro-walk-in').map(customer => <option key={customer.id} value={customer.id}>{customer.businessName}</option>)}
            </select></label>
            <QueryStatus {...customers} />
            <label>Sale location<input value={destination} onChange={event => setDestination(event.target.value)} maxLength={500} required /></label>
            <label>Payment<select value={payment} onChange={event => setPayment(event.target.value as Payment)}>
              <option value="CASH">Paid in full · Cash</option><option value="BANK_TRANSFER">Paid in full · Bank transfer</option>
              <option value="ACCOUNT">On account · Pay later</option>
            </select></label>
          </fieldset>
          <dl className="checkout-totals"><div><dt>Invoice total (PKR)</dt><dd>{currency(total)}</dd></div></dl>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary checkout-submit" disabled={posting || !cart.length || (payment === 'ACCOUNT' && !customerId)}>
            {posting ? 'Posting sale…' : 'Post sale & create invoice'}
          </button>
        </form>
      </>}
    </section>
  </div>;
}
