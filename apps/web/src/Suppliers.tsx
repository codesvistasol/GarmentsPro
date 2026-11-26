import { ListFilters, emptyFilters, matchesFilters } from './ListFilters';
import { useState } from 'react';
import { send } from './api';
import { Editor, QueryStatus, useQuery } from './warehouse-ui';

type Supplier = {
  id: string;
  company: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxNumber: string | null;
  active: boolean;
  createdAt: string;
};

const fields = [
  ['company', 'Company'], ['contactName', 'Contact name'], ['email', 'Email'],
  ['phone', 'Phone'], ['address', 'Address'], ['taxNumber', 'Tax number'],
] as const;
const blank = { id: '', company: '', contactName: null, email: null, phone: null, address: null, taxNumber: null, active: true, createdAt: "" };

export type { Supplier };

export default function Suppliers() {
  const [filters, setFilters] = useState(emptyFilters);
  const [status,setStatus] = useState('');
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<Supplier | null>(null);
  const [deactivate, setDeactivate] = useState<Supplier | null>(null);
  const results = useQuery<Supplier[]>('/suppliers?search=' + encodeURIComponent(filters.search), [], revision);
  const visible = results.data.filter(item => (!status||String(item.active)===status) && matchesFilters({...filters,search:""},item.createdAt,item.company));
  const reload = () => setRevision(previous => previous + 1);

  async function save(supplier: Supplier) {
    const { id, company, contactName, email, phone, address, taxNumber, active } = supplier;
    await send(id ? '/suppliers/' + id : '/suppliers', id ? 'PATCH' : 'POST', {
      company, contactName, email, phone, address, taxNumber, active,
    });
    reload();
  }

  return <section className="panel warehouse-panel">
    <div className="panel-head"><h2>Suppliers</h2><button className="primary" onClick={() => setEditor(blank)}>Add supplier</button></div>
    <ListFilters label="Find suppliers" dateLabel="Supplier created" onApply={setFilters}><label>Supplier status<select value={status} onChange={event=>setStatus(event.target.value)}><option value="">All statuses</option><option value="true">Active</option><option value="false">Inactive</option></select></label></ListFilters>
    <QueryStatus {...results} />
    <div className="table-scroll"><table><thead><tr>
      <th>Company</th><th>Contact</th><th>Address</th><th>Tax number</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody>{visible.map(supplier => <tr key={supplier.id}>
      <td><b>{supplier.company}</b></td>
      <td>{[supplier.contactName, supplier.email, supplier.phone].filter(Boolean).join(' · ') || '—'}</td>
      <td>{supplier.address || '—'}</td><td>{supplier.taxNumber || '—'}</td>
      <td><span className={'status ' + (supplier.active ? 'healthy' : 'warning')}>{supplier.active ? 'Active' : 'Inactive'}</span></td>
      <td><button className="textbtn" onClick={() => setEditor(supplier)}>Edit</button>
        {supplier.active && <button className="textbtn" onClick={() => setDeactivate(supplier)}>Deactivate</button>}</td>
    </tr>)}</tbody></table></div>
    {!results.loading && !visible.length && <p className="empty">No suppliers found.</p>}
    {editor && <Editor title={editor.id ? 'Edit supplier' : 'Add supplier'} onClose={() => setEditor(null)} onSave={() => save(editor)}>
      <div className="form-grid">
        {fields.map(([field, label]) => <label key={field}>{label}<input
          value={editor[field] ?? ''} required={field === 'company'} minLength={field === 'company' ? 2 : undefined}
          type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'}
          maxLength={{company:120,contactName:120,email:254,phone:50,address:500,taxNumber:80}[field]}
          onChange={event => setEditor({ ...editor, [field]: event.target.value || null })}
        /></label>)}
        <label>Status<select value={String(editor.active)} onChange={event => setEditor({ ...editor, active: event.target.value === 'true' })}>
          <option value="true">Active</option><option value="false">Inactive</option>
        </select></label>
      </div>
    </Editor>}
    {deactivate && <Editor title="Deactivate supplier" save="Deactivate" onClose={() => setDeactivate(null)} onSave={async () => {
      await send('/suppliers/' + deactivate.id, 'DELETE');
      reload();
    }}><p>Deactivate {deactivate.company}? Existing purchase records will remain available.</p></Editor>}
  </section>;
}
