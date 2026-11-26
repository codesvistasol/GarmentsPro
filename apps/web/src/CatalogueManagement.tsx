import { Eye, Pencil, Power, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { base, send } from './api';
import { CategoryOptions, type CategoryNode } from './category-options';
import { prepareProductPhoto } from './product-photo';
import { Editor, formatProductPrice } from './warehouse-ui';

export type ManagedCategory = CategoryNode & { active: boolean; createdAt: string; _count: { products: number; children: number } };
export type ManagedProduct = {
  id: string; name: string; sku: string; serialNumber: number; description?: string | null;
  categoryId: string; category: ManagedCategory; active: boolean; saleActive: boolean;
  image: { productId: string } | null; costPrice: string; salePrice: string; totalQty: number;
  variants: { sku: string; size: string; color: string; availableQty: number; reorderPoint: number }[];
};
export type ManageAction = 'view' | 'edit' | 'toggle' | 'delete';
export type Selection = { action: ManageAction } & ({ kind: 'product'; item: ManagedProduct } | { kind: 'category'; item: ManagedCategory });

export function CatalogueActions({ name, active, canDelete, onAction }: {
  name: string; active: boolean; canDelete: boolean; onAction: (action: ManageAction) => void;
}) {
  const actions = [
    ['view', 'View', Eye], ['edit', 'Edit', Pencil], ['toggle', active ? 'Deactivate' : 'Activate', Power], ['delete', 'Delete', Trash2],
  ] as const;
  return <div className="catalogue-actions">{actions.map(([action, label, Icon]) =>
    <button type="button" key={action} className={action === 'delete' ? 'is-delete' : ''}
      aria-label={label + ' ' + name} title={action === 'delete' && !canDelete ? 'Remove stock or linked entries before deleting' : label}
      disabled={action === 'delete' && !canDelete}
      onClick={event => { event.stopPropagation(); onAction(action); }}>
      <Icon size={15} aria-hidden="true" />
    </button>,
  )}</div>;
}

export function CatalogueManagement({ selection, categories, onClose, onChange }: {
  selection: Selection; categories: ManagedCategory[]; onClose: () => void; onChange: () => void;
}) {
  const { kind, action, item } = selection;
  const path = '/'+(kind === 'product' ? 'products' : 'categories')+'/'+item.id;
  if (action === 'toggle' || action === 'delete') {
    const isDelete = action === 'delete';
    const label = isDelete ? 'Delete' : item.active ? 'Deactivate' : 'Activate';
    return <Editor title={label + ' ' + item.name} save={label} onClose={onClose} onSave={async () => {
      if (isDelete) await send(path + (kind === 'product' ? '?emptyOnly=true' : ''), 'DELETE');
      else await send(path, 'PATCH', { active: !item.active });
      onChange();
    }}>
      <p>{isDelete
        ? (kind === 'product' ? 'Remove this product from the catalogue? Order and stock history will be kept.' : 'Delete this empty category?')
        : item.active ? 'Hide from new sales while keeping stock and transaction history.' : 'Make this available again. Any inactive parent category will still block new sales.'}</p>
    </Editor>;
  }
  if (kind === 'product') return <ProductEditor product={selection.item} editing={action === 'edit'} categories={categories}
    onClose={onClose} onSave={async data => { await send(path, 'PATCH', data); onChange(); }} />;
  return <CategoryEditor category={selection.item} editing={action === 'edit'} categories={categories}
    onClose={onClose} onSave={async data => { await send(path, 'PATCH', data); onChange(); }} />;
}

function ProductEditor({ product, editing, categories, onClose, onSave }: {
  product: ManagedProduct; editing: boolean; categories: ManagedCategory[]; onClose: () => void; onSave: (data: unknown) => Promise<void>;
}) {
  const [form, setForm] = useState({ name: product.name, sku: product.sku, description: product.description ?? '',
    categoryId: product.categoryId, costPrice: product.costPrice, salePrice: product.salePrice });
  const [photo, setPhoto] = useState<string | null | undefined>();
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const image = photo === undefined ? product.image && base + '/products/' + product.id + '/image' : photo;
  return <Editor title={(editing ? 'Edit ' : 'View ') + product.name} onClose={onClose}
    onSave={editing ? async () => {
      if (photoLoading || photoError) throw new Error('Finish preparing the product photo first');
      await onSave({ ...form, image: photo });
    } : undefined}>
    {image && <img className="product-photo-preview" src={image} alt={product.name} />}
    {editing ? <div className="form-grid">
      <label>Product name<input required minLength={2} maxLength={120} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })}/></label>
      <label>Product SKU<input required minLength={2} maxLength={40} value={form.sku} onChange={event => setForm({ ...form, sku: event.target.value })}/></label>
      <label>Category<select required value={form.categoryId} onChange={event => setForm({ ...form, categoryId: event.target.value })}><CategoryOptions categories={categories}/></select></label>
      <label>Description<input maxLength={1000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })}/></label>
      <label>Cost price (PKR)<input type="number" min="0" step="0.01" required value={form.costPrice} onChange={event => setForm({ ...form, costPrice: event.target.value })}/></label>
      <label>Selling price (PKR)<input type="number" min="0" step="0.01" required value={form.salePrice} onChange={event => setForm({ ...form, salePrice: event.target.value })}/></label>
      <label>Replace photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoLoading} onChange={async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        setPhotoLoading(true); setPhotoError('');
        try { setPhoto(await prepareProductPhoto(file)); } catch (error) { setPhotoError((error as Error).message); }
        finally { setPhotoLoading(false); }
      }}/></label>
      {(image || photoError) && <button className="textbtn" type="button" disabled={photoLoading} onClick={() => { setPhoto(null); setPhotoError(''); }}>Remove photo</button>}
      {photoError && <p className="error" role="alert">{photoError}</p>}
    </div> : <dl className="catalogue-details">
      <div><dt>SKU / serial</dt><dd>{product.sku} / #{product.serialNumber}</dd></div>
      <div><dt>Category</dt><dd>{product.category.name}</dd></div>
      <div><dt>Catalogue cost</dt><dd>{formatProductPrice(product.costPrice)}</dd></div>
      <div><dt>Selling price</dt><dd>{formatProductPrice(product.salePrice)}</dd></div>
      <div><dt>Status</dt><dd>{!product.saleActive ? 'Inactive' : product.totalQty === 0 ? 'Coming Soon' : 'Active'}</dd></div>
      {product.description && <div><dt>Description</dt><dd>{product.description}</dd></div>}
    </dl>}
    <h3>Variants and stock</h3>
    <ul className="catalogue-variant-list">{product.variants.map(variant =>
      <li key={variant.sku}><span>{variant.color} / {variant.size} · {variant.sku}</span><b>{variant.availableQty} on hand</b></li>,
    )}</ul>
    {editing && <p className="hint">Use Inventory / Stock to add variants, adjust stock, or edit reorder thresholds.</p>}
  </Editor>;
}

function CategoryEditor({ category, editing, categories, onClose, onSave }: {
  category: ManagedCategory; editing: boolean; categories: ManagedCategory[]; onClose: () => void; onSave: (data: unknown) => Promise<void>;
}) {
  const [name, setName] = useState(category.name);
  const [parentId, setParent] = useState(category.parentId ?? '');
  return <Editor title={(editing ? 'Edit ' : 'View ') + category.name} onClose={onClose}
    onSave={editing ? () => onSave({ name, parentId: parentId || null }) : undefined}>
    {editing ? <div className="form-grid">
      <label>Category name<input required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Parent category<select value={parentId} onChange={event => setParent(event.target.value)}>
        <option value="">Top-level category</option><CategoryOptions categories={categories.filter(item => item.id !== category.id)} />
      </select></label>
    </div> : <dl className="catalogue-details">
      <div><dt>Parent</dt><dd>{categories.find(item => item.id === category.parentId)?.name ?? 'Top level'}</dd></div>
      <div><dt>Status</dt><dd>{category.active ? 'Active' : 'Inactive'}</dd></div>
      <div><dt>Products / subcategories</dt><dd>{category._count.products} / {category._count.children}</dd></div>
    </dl>}
  </Editor>;
}
