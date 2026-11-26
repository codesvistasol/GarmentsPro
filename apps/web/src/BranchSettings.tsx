import { useState, type FormEvent } from 'react';
import { send } from './api';
import { QueryStatus, useQuery } from './warehouse-ui';

type Shop = { id: string; name: string };
export type Branch = { id: string; name: string; shop: Shop; permissions: string[]; manager: boolean };
export type Locations = { shops: Shop[]; branches: Branch[]; legacyAllowed: boolean };
type Summary = { id: string; name: string; shop: Shop; onHand: number; stockIn: number; stockOut: number; netSales: string; payments: string; balance: string };
type Access = { user: { id: string; username: string; displayName: string }; permissions: string[]; manager: boolean };
const modules = ['Dashboard','Quick Sale','Products','Categories','Inventory / Stock','Purchases','Sales & Distribution','Customers / Suppliers','Payments','Reports','Day Look','Activity Logs','Returns'];

function cents(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error('Invalid report amount');
  const absolute = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2,'0'));
  return match[1] ? -absolute : absolute;
}
function amount(value: bigint) {
  const absolute = value < 0n ? -value : value;
  return (value < 0n ? '−' : '') + (absolute / 100n).toLocaleString('en-PK') + '.' + (absolute % 100n).toString().padStart(2,'0');
}

export function BranchSettings({ locations, branch, admin, onChange }: {
  locations: Locations; branch?: Branch; admin: boolean; onChange: () => void;
}) {
  const [shopName, setShopName] = useState('');
  const [shopId, setShopId] = useState('');
  const [reportShop, setReportShop] = useState('');
  const [branchName, setBranchName] = useState('');
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<string[]>([]);
  const [manager, setManager] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const path = '/locations/branches/' + (branch?.id ?? '') + '/access';
  const access = useQuery<Access[]>(path, [], revision, Boolean(branch?.manager));
  const summary = useQuery<Summary[]>('/locations/summary', [], revision);
  const reportShops = [...new Map(summary.data.map(row => [row.shop.id, row.shop])).values()];
  const reportRows = summary.data.filter(row => !reportShop || row.shop.id === reportShop);
  const totals = reportRows.reduce((sum, row) => ({
    stockIn: sum.stockIn + row.stockIn, stockOut: sum.stockOut + row.stockOut, onHand: sum.onHand + row.onHand,
    netSales: sum.netSales + cents(row.netSales), payments: sum.payments + cents(row.payments),
    balance: sum.balance + cents(row.balance),
  }), { stockIn:0, stockOut:0, onHand:0, netSales:0n, payments:0n, balance:0n });
  const availableModules = admin ? modules : branch?.permissions ?? [];

  async function save(task: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      await task();
      setMessage(success);
      setRevision(value => value + 1);
      onChange();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent, task: () => Promise<unknown>, success: string) {
    event.preventDefault();
    void save(task, success);
  }
  return <section className="panel warehouse-panel">
    <div className="panel-head"><div><h2>Shops and branches</h2><p>Each branch has its own inventory, sales, payments and reports.</p></div></div>
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {admin && <div className="form-grid">
      <form onSubmit={event => submit(event, async () => {
        await send('/locations/shops','POST',{ name: shopName }); setShopName('');
      }, 'Shop added.')}>
        <label>Shop name<input required maxLength={100} value={shopName} onChange={e=>setShopName(e.target.value)}/></label>
        <button className="primary" disabled={busy}>Add shop</button>
      </form>
      <form onSubmit={event => submit(event, async () => {
        await send('/locations/branches','POST',{ name: branchName, shopId }); setBranchName('');
      }, 'Branch added. Select it in the top bar.')}>
        <label>Shop<select required value={shopId} onChange={e=>setShopId(e.target.value)}>
          <option value="">Choose shop</option>{locations.shops.map(shop=><option key={shop.id} value={shop.id}>{shop.name}</option>)}
        </select></label>
        <label>Branch name<input required maxLength={100} value={branchName} onChange={e=>setBranchName(e.target.value)}/></label>
        <button className="primary" disabled={busy || !locations.shops.length}>Add branch</button>
      </form>
    </div>}
    <h3>Branch stock and financial summary</h3>
    <QueryStatus {...summary}/>
    {reportShops.length > 0 && <label className="warehouse-filter">Shop dashboard
      <select value={reportShop} onChange={event=>setReportShop(event.target.value)}>
        <option value="">Show branches separately</option>
        {reportShops.map(shop=><option key={shop.id} value={shop.id}>{shop.name}</option>)}
      </select></label>}
    {reportShop && reportRows.length > 0 && <div className="sales-headline-metrics">
      <article className="sales-headline-card"><div><h3>Net sales</h3><strong>PKR {amount(totals.netSales)}</strong><p>Authorized branches in this shop</p></div></article>
      <article className="sales-headline-card"><div><h3>Net payments</h3><strong>PKR {amount(totals.payments)}</strong><p>PKR {amount(totals.balance)} outstanding</p></div></article>
      <article className="sales-headline-card"><div><h3>Stock in / out</h3><strong>{totals.stockIn} / {totals.stockOut}</strong><p>{totals.onHand} units on hand</p></div></article>
    </div>}
    {reportRows.length > 0 && <div className="table-scroll"><table>
      <thead><tr><th>Shop</th><th>Branch</th><th>Stock in</th><th>Stock out</th><th>On hand</th><th>Net sales (PKR)</th><th>Net payments (PKR)</th><th>Balance due (PKR)</th></tr></thead>
      <tbody>{reportRows.map(row=><tr key={row.id}><td>{row.shop.name}</td><td>{row.name}</td>
        <td>{row.stockIn}</td><td>{row.stockOut}</td><td>{row.onHand}</td><td>{row.netSales}</td><td>{row.payments}</td><td>{row.balance}</td></tr>)}</tbody>
    </table></div>}
    {!summary.loading && !summary.error && !summary.data.length && <p className="empty">No branches with reporting access.</p>}
    {branch?.manager && <>
      <h3>{branch.shop.name} / {branch.name} staff access</h3>
      <p>Enter an approved staff account. Adding a branch assignment restricts that account to its assigned branches.</p>
      <form onSubmit={event => submit(event, async () => {
        await send(path,'PUT',{ username, permissions: permission, manager }); setUsername(''); setPermission([]); setManager(false);
      }, 'Branch access saved.')}>
        <label>Staff username or email<input required value={username} onChange={e=>setUsername(e.target.value)}/></label>
        <fieldset className="permission-list"><legend>Allowed modules</legend>
          {availableModules.map(module=><label key={module}><input type="checkbox" checked={permission.includes(module)}
            onChange={e=>setPermission(current=>e.target.checked?[...current,module]:current.filter(item=>item!==module))}/>{module}</label>)}
          {admin && <label><input type="checkbox" checked={manager} onChange={e=>setManager(e.target.checked)}/>Manage branch access</label>}
        </fieldset>
        <button className="primary" disabled={busy}>Save access</button>
      </form>
      <QueryStatus {...access}/>
      <div className="table-scroll"><table><thead><tr><th>Staff</th><th>Modules</th><th>Actions</th></tr></thead>
        <tbody>{access.data.map(entry=><tr key={entry.user.id}><td>{entry.user.displayName}<br/>{entry.user.username}</td>
          <td>{entry.permissions.join(', ') || 'None'}{entry.manager ? ' · Manager' : ''}</td>
          <td>{(admin || !entry.manager) && <div className="warehouse-actions">
            <button type="button" className="textbtn" disabled={busy} onClick={()=>{setUsername(entry.user.username);setPermission(entry.permissions);setManager(entry.manager);}}>Edit access</button>
            <button type="button" className="textbtn" disabled={busy} onClick={()=>{
              if (window.confirm('Remove access to this branch for ' + entry.user.username + '?')) {
                void save(()=>send(path+'/'+entry.user.id,'DELETE'),'Branch access removed.');
              }
            }}>Remove access</button>
          </div>}</td></tr>)}</tbody>
      </table></div>
    </>}
  </section>;
}
