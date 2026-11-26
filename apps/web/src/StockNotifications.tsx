import { Bell, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { QueryStatus, useQuery } from './warehouse-ui';
import { send } from './api';

type StockAlert = { id: string; name: string; sku: string };
type SignupRequest = { id: string; displayName: string; username: string };
const emptyRequests = { items: [] as SignupRequest[], total: 0 };
export function StockNotifications({ revision, onProduct, onApprove }: {
  revision: number; onProduct: (sku: string) => void; onApprove?: (id: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const query = useQuery<StockAlert[]>('/stock-alerts', [], revision + tick);
  const requests = useQuery('/settings/signup-requests', emptyRequests, revision + tick, Boolean(onApprove));
  const previousRequests = useRef<{ ids: Set<string>; total: number }>();
  const showRequests = Boolean(onApprove);
  const [cancelling, setCancelling] = useState(false);
  const [requestError, setRequestError] = useState('');
  const count = query.data.length + requests.data.total;
  const previous = useRef<Set<string>>();
  useEffect(() => {
    const timer = window.setInterval(() => setTick(value => value + 1), 12000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (query.loading || query.error) return;
    const next = new Set(query.data.map(item => item.id));
    const last = previous.current;
    previous.current = next;
    if (!last) return;
    const added = query.data.filter(item => !last.has(item.id));
    if (added.length) setMessage(added.length === 1 ? added[0].name + ' is out of stock' : added.length + ' products are now out of stock');
  }, [query.data, query.error, query.loading]);
  useEffect(() => {
    if (!showRequests || requests.loading || requests.error) return;
    const { items, total } = requests.data;
    const last = previousRequests.current;
    if (total > (last?.total ?? 0) || (last && total === last.total && items.some(item => !last.ids.has(item.id)))) {
      setMessage(total === 1 ? 'New staff sign-up request' : total + ' staff sign-up requests pending');
    }
    previousRequests.current = { ids: new Set(items.map(item => item.id)), total };
  }, [requests.data, requests.loading, requests.error, showRequests]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 7000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return <div className="stock-notifications">
    <button className="iconbtn" type="button" title="Notifications" aria-label="Notifications" aria-expanded={open} onClick={() => {setOpen(!open); if (!open) setTick(value => value + 1);}}>
      <Bell size={18}/>{count > 0 && <span className="notification-count">{count}</span>}
    </button>
    {message && <div className="notification-toast" role="status">{message}<button type="button" className="textbtn" aria-label="Dismiss notification" onClick={() => setMessage('')}><X size={15}/></button></div>}
    {open && <section className="notification-panel" aria-label="Notifications" onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
      <div className="panel-head"><h2>Notifications</h2><button className="textbtn" type="button" onClick={() => setOpen(false)}>Close</button></div>
      {onApprove && <>
        <h3>Staff sign-up requests</h3>
        {(requests.error || requestError) && <QueryStatus loading={false} error={requestError || requests.error}/>}
        {!requests.data.items.length && !requests.error && <p className="hint">{requests.loading ? 'Checking requests…' : 'No pending sign-up requests.'}</p>}
        <ul>{requests.data.items.map(item => <li className="signup-notification" key={item.id}>
          <strong>{item.displayName}</strong><small>{item.username}</small>
          <div className="warehouse-actions">
            <button type="button" className="primary" onClick={() => { setOpen(false); setMessage(''); onApprove(item.id); }}>Approve</button>
            <button type="button" className="textbtn" disabled={cancelling} onClick={async () => {
              if (!window.confirm('Cancel the sign-up request for ' + item.username + '?')) return;
              setCancelling(true);
              setRequestError('');
              try { await send('/settings/signup-requests/' + item.id + '/cancel', 'POST'); setMessage(''); }
              catch (error) { setRequestError((error as Error).message); }
              finally { setCancelling(false); setTick(value => value + 1); }
            }}>Cancel request</button>
          </div>
        </li>)}</ul>
        {requests.data.total > requests.data.items.length && <p className="hint">Showing the 25 most recent requests.</p>}
      </>}
      <h3>Stock alerts</h3>
      {query.error && <QueryStatus loading={false} error={query.error} />}
      {!query.data.length && !query.error && <p className="hint">{query.loading ? 'Checking stock…' : 'No active products are out of stock.'}</p>}
      <ul>{query.data.map(item => <li key={item.id}>
        <button type="button" onClick={() => { setOpen(false); onProduct(item.sku); }}>
          <strong>{item.name}</strong><small>{item.sku}</small><span>Out of stock</span>
        </button>
      </li>)}</ul>
    </section>}
  </div>;
}
