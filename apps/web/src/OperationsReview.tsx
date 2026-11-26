import { useState, type FormEvent } from 'react';
import { ListFilters, emptyFilters } from './ListFilters';
import { QueryStatus, useQuery } from './warehouse-ui';

type DaySummary = {
  dispatches: number; sales: string; returns: number; returnCredits: string; netSales: string;
  paymentCount: number; payments: string; refundsRecorded: string;
  stockIn: number; stockOut: number; damaged: number; receipts: number;
  buyers: { id: string; reference: string; destination: string; total: string; createdAt: string; order: { customerName: string; number: string } }[];
  ledgerRows: { id: string; createdAt: string; type: string; quantity: number; balanceAfter: number; reference: string | null; variant: { sku: string } }[];
};
type Activity = { id: string; createdAt: string; area: string; action: string; reference: string; actorName: string | null };
const today = () => new Date().toISOString().slice(0, 10);
const count = (value: number) => value.toLocaleString('en-PK');
const timestamp = (value: string) => value.slice(0, 19).replace('T', ' ');
function money(value: string) {
  const [whole, fraction = '00'] = value.split('.');
  const signed = whole.startsWith('-');
  return (signed ? '−' : '') + 'PKR ' + BigInt(signed ? whole.slice(1) : whole).toLocaleString('en-PK') + '.' + fraction.padEnd(2,'0');
}

export function DayLook({ revision, location }: { revision: number; location?: string }) {
  const [day, setDay] = useState(today);
  const [draft, setDraft] = useState(day);
  const query = useQuery<DaySummary | null>('/day-look?day=' + day, null, revision);
  const data = query.data;
  function submit(event: FormEvent) { event.preventDefault(); setDay(draft); }
  return <section className="panel warehouse-panel daily-review">
    <div className="panel-head"><div><h2>Daily warehouse summary</h2>{location && <p><strong>{location}</strong></p>}<p>Sales, payments and inventory posted on the selected UTC date.</p></div></div>
    <form className="warehouse-filters list-filters daily-date-filter" onSubmit={submit}>
      <label>Business date (UTC)<input type="date" required value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <div className="list-filter-actions"><button className="primary">Show day</button>
        <button className="textbtn" type="button" onClick={() => { setDraft(today()); setDay(today()); }}>Today</button></div>
    </form>
    <QueryStatus {...query} />
    {data && !query.loading && !query.error && <>
      <div className="sales-headline-metrics">
        <article className="sales-headline-card sales-headline-primary"><div><h3>Net sales</h3><strong>{money(data.netSales)}</strong><p>{count(data.dispatches)} dispatches · {count(data.returns)} returns</p></div></article>
        <article className="sales-headline-card"><div><h3>Payments recorded</h3><strong>{money(data.payments)}</strong><p>{count(data.paymentCount)} payments · {money(data.refundsRecorded)} refunds recorded</p></div></article>
        <article className="sales-headline-card"><div><h3>Stock in / out</h3><strong>{count(data.stockIn)} / {count(data.stockOut)}</strong><p>{count(data.receipts)} receipts · {count(data.damaged)} damaged units</p></div></article>
      </div>
      <dl className="daily-totals"><div><dt>Dispatched value</dt><dd>{money(data.sales)}</dd></div><div><dt>Return credits</dt><dd>{money(data.returnCredits)}</dd></div></dl>
      <h3>Latest customer purchases</h3>
      {data.buyers.length ? <div className="table-scroll"><table><thead><tr><th>Time (UTC)</th><th>Customer / shop</th><th>Order</th><th>Invoice reference</th><th>Sale / dispatch location</th><th>Amount</th></tr></thead>
        <tbody>{data.buyers.map(row => <tr key={row.id}><td>{timestamp(row.createdAt)}</td><td>{row.order.customerName}</td><td>{row.order.number}</td><td>{row.reference}</td><td>{row.destination}</td><td>{money(row.total)}</td></tr>)}</tbody></table></div> : <p className="empty">No customer purchases posted on this date.</p>}
      <h3>Latest stock movements</h3>
      {data.ledgerRows.length ? <div className="table-scroll"><table><thead><tr><th>Time (UTC)</th><th>Variant SKU</th><th>Movement</th><th>Reference</th><th>Change</th><th>Balance</th></tr></thead>
        <tbody>{data.ledgerRows.map(row => <tr key={row.id}><td>{timestamp(row.createdAt)}</td><td className="mono">{row.variant.sku}</td>
          <td>{row.type.toLowerCase().replace(/_/g, ' ')}</td><td>{row.reference ?? '—'}</td><td>{row.quantity > 0 ? '+' : ''}{count(row.quantity)}</td>
          <td>{count(row.balanceAfter)}</td></tr>)}</tbody></table></div> : <p className="empty">No stock movements on this date.</p>}
    </>}
  </section>;
}

export function ActivityLogs({ revision }: { revision: number }) {
  const [filters,setFilters] = useState(emptyFilters);
  const [area,setArea] = useState('');
  const [page,setPage] = useState(1);
  const [refresh,setRefresh] = useState(0);
  const params = new URLSearchParams({ page: String(page) });
  for(const [key,value] of Object.entries({ ...filters, area })) if(value) params.set(key,value);
  const query = useQuery<{ items: Activity[]; total: number }>('/activity-logs?' + params, { items: [], total: 0 }, revision + refresh);
  const pages = Math.max(1,Math.ceil(query.data.total/25));
  return <section className="panel warehouse-panel">
    <div className="panel-head"><div><h2>Activity history</h2><p>Committed changes recorded since logging was enabled.</p></div><button type="button" className="textbtn" onClick={()=>setRefresh(value=>value+1)}>Refresh logs</button></div>
    <ListFilters label="Find reference, action or staff" dateLabel="Activity date" onApply={value => {setFilters(value);setPage(1)}}>
      <label>Module<select value={area} onChange={event=>{setArea(event.target.value);setPage(1)}}>
        <option value="">All modules</option>{['Catalogue','Inventory','Purchases','Sales','Payments','Customers','Settings'].map(item=><option key={item}>{item}</option>)}
      </select></label>
    </ListFilters>
    <QueryStatus {...query} />
    {!query.loading && !query.error && <>
      {query.data.items.length > 0 ? <div className="table-scroll"><table><thead><tr><th>Time (UTC)</th><th>Module</th><th>Action</th><th>Reference</th><th>Staff</th></tr></thead>
        <tbody>{query.data.items.map(row=><tr key={row.id}><td>{timestamp(row.createdAt)}</td><td>{row.area}</td><td><b>{row.action}</b></td><td>{row.reference || "—"}</td><td>{row.actorName ?? "Unattributed"}</td></tr>)}</tbody></table></div>
        : <p className="empty">No activity matches these filters.</p>}
      {pages > 1 && <div className="actions">
        <button disabled={page<=1} onClick={()=>setPage(page-1)}>Previous</button><span className="hint">Page {page} of {pages}</span>
        <button disabled={page>=pages} onClick={()=>setPage(page+1)}>Next</button>
      </div>}
    </>}
  </section>;
}
