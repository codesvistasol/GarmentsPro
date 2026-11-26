import { useState } from 'react';
import Papa from 'papaparse';
import { send } from './api';
import { Editor } from './warehouse-ui';

const headings = ['sku','name','category','subcategory','description','costPrice','salePrice','active','variantSku','size','color','availableQty','reorderPoint'] as const;
type Header = typeof headings[number];
const required = ['sku','name','category','costPrice','salePrice','variantSku','size','color'] as const;
const template = Papa.unparse([
  headings,
  ['SHIRT-01','Cotton Oxford','Shirts','Oxford','Example product','850.00','1200.00','true','SHIRT-01-M-BLUE','M','Blue','10','5'],
  ['SHIRT-01','Cotton Oxford','Shirts','Oxford','Example product','850.00','1200.00','true','SHIRT-01-L-BLUE','L','Blue','8','5'],
]);

type ImportRow = Record<Header, string | number | boolean | undefined>;
const cleanKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function parseMatrix(matrix: unknown[][]): ImportRow[] {
  const data = matrix.map(row => row.map(value => String(value ?? '').trim())).filter(row => row.some(Boolean));
  const [header, ...records] = data;
  if (!header || !records.length) throw new Error('Add a header row and at least one product variant.');
  if (records.length > 500) throw new Error('Import up to 500 variant rows at a time.');
  const keys = header.map(cleanKey);
  const indexes = new Map(headings.map(key => [key, keys.indexOf(cleanKey(key))]));
  const missing = required.filter(key => indexes.get(key) === -1);
  if (missing.length) throw new Error('Missing columns: ' + missing.join(', '));
  for (const key of headings) {
    if (keys.filter(value => value === cleanKey(key)).length > 1) throw new Error('Duplicate column: ' + key);
  }
  return records.map((cells, index) => {
    const read = (key: Header) => cells[indexes.get(key) ?? -1] || '';
    const row = index + 2;
    for (const key of required) if (!read(key)) throw new Error('Row ' + row + ': ' + key + ' is required.');
    for (const key of ['costPrice','salePrice'] as const) {
      if (!/^\d{1,10}(\.\d{1,2})?$/.test(read(key))) throw new Error('Row ' + row + ': use a numeric price with up to two decimals.');
    }
    const count = (key: 'availableQty' | 'reorderPoint', fallback: number) => {
      const value = read(key);
      if (!value) return fallback;
      if (!/^\d+$/.test(value) || Number(value) > 2147483647) throw new Error('Row ' + row + ': ' + key + ' must be a whole number.');
      return Number(value);
    };
    const active = read('active').toLowerCase();
    if (active && !['true','false','yes','no','active','inactive','1','0'].includes(active)) {
      throw new Error('Row ' + row + ': active must be true or false.');
    }
    return {
      sku: read('sku'), name: read('name'), category: read('category'), subcategory: read('subcategory') || undefined,
      description: read('description') || undefined, costPrice: read('costPrice'), salePrice: read('salePrice'),
      active: !['false','no','inactive','0'].includes(active), variantSku: read('variantSku'),
      size: read('size'), color: read('color'), availableQty: count('availableQty', 0), reorderPoint: count('reorderPoint', 5),
    };
  });
}

function parseText(text: string) {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', delimiter: text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',' });
  if (parsed.errors.length) throw new Error(parsed.errors[0].message);
  return parseMatrix(parsed.data);
}

export default function BulkImport({ onClose, onImported }: {
  onClose: () => void; onImported: (result: { products: number; variants: number }) => void;
}) {
  const [paste, setPaste] = useState('');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function preview(read: () => Promise<ImportRow[]>, label: string) {
    setError(''); setRows([]); setLoading(true);
    try { setRows(await read()); setSource(label); }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  }
  return <Editor title="Import products" save="Import all rows" onClose={onClose} onSave={async () => {
    if (loading || !rows.length) throw new Error('Load and review a spreadsheet preview first.');
    onImported(await send('/products/import', 'POST', { rows }));
  }}>
    <p className="hint">Use one row per size/color variant. Repeat the same product SKU and product details for its other variants. Existing SKUs are kept as they are.</p>
    <a className="textbtn" download="garmentpro-product-template.csv" href={'data:text/csv;charset=utf-8,' + encodeURIComponent(template)}>Download CSV template</a>
    <label>Excel or CSV file<input type="file" accept=".xlsx,.csv,text/csv" disabled={loading} onChange={event => {
      const file = event.target.files?.[0];
      if (!file) return;
      void preview(async () => {
        if (file.size > 4 * 1024 * 1024) throw new Error('Choose a spreadsheet under 4 MB.');
        if (/\.xlsx$/i.test(file.name)) {
          const { readSheet } = await import('read-excel-file/browser');
          return parseMatrix(await readSheet(file));
        }
        if (!/\.csv$/i.test(file.name)) throw new Error('Choose an .xlsx or .csv file.');
        return parseText(await file.text());
      }, file.name);
    }}/></label>
    <label>Paste from Google Sheets<textarea rows={4} value={paste} disabled={loading} maxLength={900000} placeholder="Copy the cells, including column headers, and paste them here."
      onChange={event => { setPaste(event.target.value); setRows([]); setError(''); }}/></label>
    <button type="button" className="textbtn" disabled={loading || !paste.trim()} onClick={() => void preview(async () => parseText(paste), 'Google Sheets / pasted cells')}>Preview pasted rows</button>
    {loading && <p role="status">Reading spreadsheet…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {rows.length > 0 && <div className="import-preview">
      <h3>{source} · {rows.length} variant rows</h3>
      <div className="table-scroll"><table><thead><tr><th>Product SKU</th><th>Name</th><th>Category</th><th>Variant SKU</th><th>Qty</th><th>Sale price</th></tr></thead>
        <tbody>{rows.slice(0, 8).map((row, index) => <tr key={index}><td>{row.sku}</td><td>{row.name}</td><td>{row.subcategory || row.category}</td><td>{row.variantSku}</td><td>{row.availableQty}</td><td>{row.salePrice}</td></tr>)}</tbody>
      </table></div>
      {rows.length > 8 && <p className="hint">Showing first 8 rows. Import saves all {rows.length} rows together.</p>}
    </div>}
  </Editor>;
}
