import { ListFilters, emptyFilters, matchesFilters } from './ListFilters';
import { useState } from 'react';
import { send } from './api';
import { Editor, QueryStatus, useQuery } from './warehouse-ui';

export const customerTypes = { CUSTOMER: 'Customer', SHOP: 'Shop', WHOLESALE: 'Wholesale dealer' } as const;
export type Customer = {
  id: string; businessName: string; type: keyof typeof customerTypes; contactName: string | null;
  email: string | null; phone: string | null; address: string | null; creditLimit: string; creditDays: number; archived: boolean; createdAt: string;
};
const initial: Customer = {
  id: '', businessName: '', type: 'CUSTOMER', contactName: null, email: null, phone: null, address: null,
  creditLimit: '0', creditDays: 0, archived: false, createdAt: '',
};
const contactFields = [
  ['contactName', 'Contact name', 120], ['email', 'Email', 254], ['phone', 'Phone', 50], ['address', 'Address', 500],
] as const;

export default function Customers() {
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<Customer | null>(null);
  const [archive, setArchive] = useState<Customer | null>(null);
  const [filters, setFilters] = useState(emptyFilters);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('active');
  const params = new URLSearchParams({ search: filters.search, status });
  if (type) params.set('type', type);
  const query = useQuery<Customer[]>('/customers?' + params.toString(), [], revision);
  const visible = query.data.filter(item => matchesFilters({...filters,search:""},item.createdAt,item.businessName));
  const reload = () => setRevision(previous => previous + 1);
  return <section className="panel warehouse-panel">
    <div className="panel-head"><h2>Customers</h2><button className="primary" onClick={() => setDraft(initial)}>Add customer</button></div>
    <ListFilters label="Find customers" dateLabel="Customer created" onApply={setFilters}>
      <label>Customer type<select value={type} onChange={event => setType(event.target.value)}><option value="">All types</option>
        {Object.entries(customerTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="active">Active</option>
        <option value="archived">Archived</option><option value="all">All</option>
      </select></label>
    </ListFilters>
    <QueryStatus {...query} />
    <div className="table-scroll"><table><thead><tr><th>Business</th><th>Type</th><th>Contact</th><th>Address</th><th>Credit limit</th><th>Terms</th><th>Actions</th></tr></thead>
    <tbody>{visible.map(customer => <tr key={customer.id}>
      <td><b>{customer.businessName}</b>{customer.archived && ' (archived)'}</td><td>{customerTypes[customer.type]}</td>
      <td>{[customer.contactName, customer.email, customer.phone].filter(Boolean).join(' · ') || '—'}</td>
      <td>{customer.address || '—'}</td><td>PKR {customer.creditLimit}</td><td>{customer.creditDays} days</td>
      <td><button className="textbtn" onClick={() => setDraft(customer)}>Edit</button>
        {!customer.archived && <button className="textbtn" onClick={() => setArchive(customer)}>Archive</button>}</td>
    </tr>)}</tbody></table></div>
    {!query.loading && !visible.length && <p className="empty">No matching customers.</p>}
    {draft && <Editor title={draft.id ? 'Edit customer' : 'Add customer'} onClose={() => setDraft(null)} onSave={async () => {
      const { id, businessName, type, contactName, email, phone, address, creditLimit, creditDays } = draft;
      await send(id ? '/customers/' + id : '/customers', id ? 'PATCH' : 'POST',
        { businessName, type, contactName, email, phone, address, creditLimit, creditDays });
      reload();
    }}><div className="form-grid">
      <label>Business name<input required minLength={2} maxLength={120} value={draft.businessName}
        onChange={event => setDraft({ ...draft, businessName: event.target.value })} /></label>
      <label>Customer type<select value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value as Customer['type'] })}>
        {Object.entries(customerTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      {contactFields.map(([field, label, max]) => <label key={field}>{label}<input maxLength={max}
        type={field === 'email' ? 'email' : 'text'} value={draft[field] ?? ''}
        onChange={event => setDraft({ ...draft, [field]: event.target.value || null })} /></label>)}
      <label>Credit limit (PKR)<input type="number" required min="0" max="9999999999.99" step="0.01" value={draft.creditLimit}
        onChange={event => setDraft({ ...draft, creditLimit: event.target.value })} /></label>
      <label>Credit terms (days)<input type="number" required min="0" max="3650" value={draft.creditDays}
        onChange={event => setDraft({ ...draft, creditDays: Number(event.target.value) })} /></label>
    </div></Editor>}
    {archive && <Editor title="Archive customer" save="Archive" onClose={() => setArchive(null)} onSave={async () => {
      await send('/customers/' + archive.id, 'DELETE'); reload();
    }}><p>Archive {archive.businessName}? Existing orders and payment history will remain available.</p></Editor>}
  </section>;
}
