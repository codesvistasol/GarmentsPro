import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpRight, Boxes, ChevronLeft, ChevronRight, Layers, Plus, ReceiptText, Search, Shirt, Wallet, X } from 'lucide-react';
import { base } from './api';
import { formatProductPrice, QueryStatus, useQuery } from './warehouse-ui';
import './dashboard.css';

type Category = { id: string; name: string; parentId?: string | null; active?: boolean };
type Product = {
  id: string;
  name: string;
  sku: string;
  category: Category;
  serialNumber: number;
  image: { productId: string } | null;
  costPrice: string;
  salePrice: string;
  totalQty: number;
  variants: { id?: string; sku: string; color: string; size: string; availableQty: number; reorderPoint: number }[];
};
type Stock = {
  products: number;
  availableUnits: number;
  inventoryCost: number;
  lowStock: { sku: string; name: string; availableQty: number }[];
  byCategory: { name: string; qty: number }[];
};
type Props = {
  categories: Category[];
  stock: Stock | null;
  search: string;
  onSearch: (value: string) => void;
  revision: number;
  onAddProduct?: () => void;
  onAddCategory?: () => void;
  onProducts?: () => void;
  onInventory?: () => void;
  onPurchases?: () => void;
  onReports?: () => void;
  onQuickSale?: () => void;
  onArchiveProduct?: (id: string, name: string) => void;
};

const number = (value: number | undefined) => value?.toLocaleString('en-PK') ?? '—';
const stockValue = new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', maximumFractionDigits: 0 });

export default function WarehouseDashboard({
  categories, stock, search, onSearch, revision, onAddProduct, onAddCategory, onProducts, onInventory, onPurchases, onReports, onQuickSale, onArchiveProduct,
}: Props) {
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [page, setPage] = useState(1);
  const [needle, setNeedle] = useState(search);
  const [selectedId, setSelectedId] = useState('');
  const rail = useRef<HTMLElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => { setNeedle(search.trim()); setPage(1); }, 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = new URLSearchParams({ page: String(page), search: needle, sort: 'photo' });
  if (categoryId) {
    params.set('categoryId', subcategoryId || categoryId);
    if (!subcategoryId) params.set('includeChildren', 'true');
  }
  const catalogue = useQuery<{ items: Product[]; total: number }>('/products?' + params, { items: [], total: 0 }, revision);
  const business = useQuery<{
    totalSales: string; grossProfit: string; stockIn: number; stockOut: number;
    topProducts: { name: string; quantity: number; stock: number }[];
  } | null>('/sales-dashboard', null, revision, Boolean(onReports));
  const [previewLimit, setPreviewLimit] = useState(9);
  useEffect(() => { setPreviewLimit(9); }, [categoryId, subcategoryId, needle, page]);
  const selected = catalogue.data.items.find(item => item.id === selectedId);
  const pages = Math.max(1, Math.ceil(catalogue.data.total / 25));
  const childCategories = categories.filter(item => item.parentId === categoryId && item.active!==false);
  const maxCategory = Math.max(1, ...(stock?.byCategory ?? []).map(item => item.qty));
  const metrics = [
    { name: 'Product styles', value: number(stock?.products), icon: Shirt, tone: 'green', note: 'Active catalogue' },
    { name: 'On-hand stock', value: number(stock?.availableUnits), icon: Boxes, tone: 'blue', note: 'Units across variants' },
    { name: 'Inventory value', value: stock ? stockValue.format(stock.inventoryCost) : '—', icon: Wallet, tone: 'sand', note: 'At recorded cost' },
    { name: 'Low-stock variants', value: number(stock?.lowStock.length), icon: AlertTriangle, tone: 'rose', note: 'At or below reorder point' },
  ];

  function selectProduct(id: string) {
    setSelectedId(id === selectedId ? '' : id);
    if (id !== selectedId && window.matchMedia('(max-width: 1060px)').matches) {
      window.requestAnimationFrame(() => rail.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
  }

  return <div className="warehouse-dashboard">
    <section className="studio-banner" aria-labelledby="warehouse-heading">
      <div className="studio-banner-art" aria-hidden="true" />
      <div className="studio-banner-content">
        <p className="studio-kicker"><span /> Warehouse operations</p>
        <h2 id="warehouse-heading">Your stock, <em>in view.</em></h2>
        <p className="studio-intro">Browse your catalogue and see what needs restocking.</p>
        <div className="studio-banner-actions">
          {onQuickSale && <button className="studio-button studio-button-light" onClick={onQuickSale}><ReceiptText size={17} /> New sale</button>}
          {onAddProduct && <button className="studio-button studio-button-outline" onClick={onAddProduct}><Plus size={17} /> Add product</button>}
          {onPurchases && <button className="studio-button studio-button-outline" onClick={onPurchases}><ArrowDownToLine size={16} /> Receive stock</button>}
        </div>
      </div>
    </section>

    <div className="studio-metrics" aria-label="Warehouse totals">
      {metrics.map(({ name, value, icon: Icon, tone, note }) => <div className="studio-metric" key={name}>
        <span className={'studio-metric-icon studio-tone-' + tone}><Icon size={18} /></span>
        <div><span>{name}</span><strong>{value}</strong><small>{note}</small></div>
      </div>)}
    </div>

    <div className="studio-workspace">
      <section className="studio-catalogue" aria-labelledby="catalogue-heading">
        <div className="studio-section-head">
          <div><h2 id="catalogue-heading">Product catalogue</h2><p>{catalogue.loading ? 'Loading products…' : catalogue.error ? 'Catalogue unavailable' : number(catalogue.data.total) + ' matching styles'}</p></div>
          {onProducts && <button className="studio-link" onClick={onProducts}>View products <ArrowUpRight size={15} /></button>}
        </div>
        <div className="studio-catalogue-tools">
          <label className="studio-search"><Search size={16} /><input aria-label="Search catalogue" placeholder="Search name, SKU or serial…" maxLength={100} value={search} onChange={event => onSearch(event.target.value)} />{search && <button aria-label="Clear catalogue search" onClick={() => onSearch('')}><X size={15} /></button>}</label>
          {onAddCategory && <button className="studio-link studio-category-action" onClick={onAddCategory}><Plus size={15} /> Category</button>}
        </div>
        <div className="studio-categories" aria-label="Filter by category">
          {[{ id: '', name: 'All products' }, ...categories.filter(item => !item.parentId && item.active!==false)].map(category => <button key={category.id}
            className={categoryId === category.id ? 'studio-category is-selected' : 'studio-category'}
            aria-pressed={categoryId === category.id}
            onClick={() => { setCategoryId(category.id); setSubcategoryId(''); setPage(1); setSelectedId(''); }}>{category.name}</button>)}
        </div>
        {childCategories.length > 0 && <div className="studio-categories" aria-label="Filter by subcategory">
          {[{ id: '', name: 'All subcategories' }, ...childCategories].map(item => <button key={item.id}
            className={subcategoryId === item.id ? 'studio-category is-selected' : 'studio-category'}
            aria-pressed={subcategoryId === item.id}
            onClick={() => { setSubcategoryId(item.id); setPage(1); setSelectedId(''); }}>{item.name}</button>)}
        </div>}
        <QueryStatus {...catalogue} />
        {!catalogue.loading && !catalogue.error && (catalogue.data.items.length ? <>
          <div className="studio-product-grid">
            {catalogue.data.items.slice(0, previewLimit).map((product, index) => {
              const low = product.variants.some(variant => variant.availableQty <= variant.reorderPoint);
              return <button key={product.id} className={'studio-product' + (selectedId === product.id ? ' is-selected' : '')}
                onClick={() => selectProduct(product.id)} aria-pressed={selectedId === product.id}>
                <div className={'studio-product-media studio-media-' + index % 4}>
                  {product.image ? <img src={base + '/products/' + product.id + '/image'} alt={product.name} loading="lazy" /> :
                    <span className="studio-photo-empty"><Shirt size={32} strokeWidth={1.2} /><span>No photo</span></span>}
                  <span className={'studio-stock-tag' + (low ? ' is-low' : '')}>{product.totalQty === 0 ? 'Coming Soon' : number(product.totalQty) + ' on hand'}</span>
                </div>
                <div className="studio-product-body">
                  <span className="studio-product-code">{product.sku} <span>·</span> #{product.serialNumber}</span>
                  <strong>{product.name}</strong>
                  <div><span>{product.category.name}</span><b>{formatProductPrice(product.salePrice)}</b></div>
                </div>
              </button>;
            })}
          </div>
          <div className="studio-catalogue-footer">
            {previewLimit < catalogue.data.items.length && <button className="studio-link" onClick={() => setPreviewLimit(value => value + 9)}>Show more products</button>}
            {pages > 1 && <div className="studio-page">
              <button aria-label="Previous catalogue page" disabled={page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={17} /></button>
              <span>{page} / {pages}</span>
              <button aria-label="Next catalogue page" disabled={page >= pages} onClick={() => setPage(value => value + 1)}><ChevronRight size={17} /></button>
            </div>}
          </div>
        </> : <p className="studio-empty">No products match these filters.</p>)}
      </section>

      <aside className="studio-rail" ref={rail} aria-label="Stock details">
        {selected && <section className="studio-rail-card studio-selected-product" aria-label="Selected product details">
          <div className="studio-rail-title"><Shirt size={17} /><h2>{selected.name}</h2>
            <button className="studio-icon-button" aria-label="Close product details" onClick={() => setSelectedId('')}><X size={16} /></button>
          </div>
          <p>{selected.category.name} · {selected.sku}</p>
          <strong className="studio-detail-price">{formatProductPrice(selected.salePrice)}</strong>
          <p>Catalogue cost per unit {formatProductPrice(selected.costPrice)}</p>
          <h3>Variant stock</h3>
          {selected.variants.length ? <ul>{selected.variants.map(variant => <li key={variant.sku}><span>{variant.color} · {variant.size}</span><b>{number(variant.availableQty)}</b></li>)}</ul> :
            <p className="studio-empty">No variants added.</p>}
          {onArchiveProduct && <button className="studio-link studio-rail-link" disabled={selected.totalQty > 0} onClick={() => onArchiveProduct?.(selected.id, selected.name)}>Delete product</button>}
        </section>}
        {onReports && <section className="studio-rail-card">
          <div className="studio-rail-title"><Wallet size={17} /><h2>Business summary</h2></div>
          <p>All posted activity</p>
          <QueryStatus {...business} />
          {business.data && !business.loading && !business.error && <ul className="studio-breakdown">
            <li><div><strong>Net sales</strong><b>{formatProductPrice(business.data.totalSales)}</b></div></li>
            <li><div><strong>{Number(business.data.grossProfit) < 0 ? 'Gross loss' : 'Gross profit'}</strong><b>{formatProductPrice(business.data.grossProfit)}</b></div></li>
            <li><div><strong>Stock in / out</strong><b>{number(business.data.stockIn)} / {number(business.data.stockOut)}</b></div></li>
            {business.data.topProducts[0] && <li><div><strong>Most sold</strong><b>{number(business.data.topProducts[0].quantity)} units</b></div>
              <p>{business.data.topProducts[0].name}</p></li>}
          </ul>}
          <button className="studio-link studio-rail-link" onClick={onReports}>Open sales and pricing reports <ArrowUpRight size={14}/></button>
        </section>}
        <section className="studio-rail-card">
          <div className="studio-rail-title"><AlertTriangle size={17} /><h2>Stock watch</h2></div>
          <p>Variants at or below reorder level</p>
          {stock ? stock.lowStock.length ? <ul className="studio-alerts">{stock.lowStock.slice(0, 5).map(item => <li key={item.sku}>
            <div><strong>{item.name}</strong><small>{item.sku}</small></div><span>{item.availableQty} left</span>
          </li>)}</ul> : <p className="studio-empty">All variants are above their reorder levels.</p> : <p className="studio-empty">Stock figures unavailable.</p>}
          {onInventory && <button className="studio-link studio-rail-link" onClick={onInventory}>Open inventory <ArrowUpRight size={14} /></button>}
        </section>
        <section className="studio-rail-card">
          <div className="studio-rail-title"><Layers size={17} /><h2>Stock by category</h2></div>
          <p>On-hand units in active styles</p>
          {stock?.byCategory.length ? <ul className="studio-breakdown">{stock.byCategory.slice().sort((a, b) => b.qty - a.qty).slice(0, 6).map(item => <li key={item.name}>
            <div><strong>{item.name}</strong><b>{number(item.qty)}</b></div>
            <span className="studio-bar" aria-hidden="true"><span style={{ width: (item.qty / maxCategory * 100) + '%' }} /></span>
          </li>)}</ul> : <p className="studio-empty">No category stock to display.</p>}
        </section>
      </aside>
    </div>
  </div>;
}
