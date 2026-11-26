import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Search } from 'lucide-react';

export const emptyFilters = { search: '', from: '', to: '' };
export type Filters = typeof emptyFilters;
export function matchesFilters(filters: Filters, date: string, ...fields: (string | null | undefined)[]) {
  const day = date.slice(0, 10);
  return (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to) &&
    fields.some(value => (value ?? '').toLowerCase().includes(filters.search.toLowerCase()));
}

function dateRange(period: string) {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (period === 'today') return { from: to, to };
  if (period === 'week') return { from: new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10), to };
  if (period === 'year') return { from: to.slice(0, 4) + '-01-01', to };
  return { from: '', to: '' };
}

export function ListFilters({ label = 'Search', dateLabel, initialSearch = '', onApply, children, searchable = true }: {
  label?: string; dateLabel: string; initialSearch?: string; onApply: (filters: Filters) => void;
  children?: ReactNode; searchable?: boolean;
}) {
  const [draft, setDraft] = useState({ ...emptyFilters, search: initialSearch });
  const [period, setPeriod] = useState('all');
  useEffect(() => setDraft(value => ({ ...value, search: initialSearch })), [initialSearch]);
  function submit(event: FormEvent) {
    event.preventDefault();
    onApply({ ...draft, search: draft.search.trim() });
  }
  return <form className="warehouse-filters list-filters" onSubmit={submit}>
    {searchable && <label>{label}<input maxLength={100} value={draft.search} onChange={e => setDraft({ ...draft, search: e.target.value })} /></label>}
    <label>{dateLabel}<select value={period} onChange={e => {
      setPeriod(e.target.value);
      if (e.target.value !== 'custom') setDraft({ ...draft, ...dateRange(e.target.value) });
    }}>
      <option value="all">All dates</option><option value="today">Today</option><option value="week">Last 7 days</option>
      <option value="year">This year</option><option value="custom">Custom dates</option>
    </select></label>
    {period === 'custom' && <>
      <label>From (UTC)<input type="date" value={draft.from} max={draft.to || undefined} onChange={e => setDraft({ ...draft, from: e.target.value })}/></label>
      <label>Through (UTC)<input type="date" value={draft.to} min={draft.from || undefined} onChange={e => setDraft({ ...draft, to: e.target.value })}/></label>
    </>}
    {children}
    <div className="list-filter-actions">
      <button className="primary" type="submit"><Search size={15}/>{searchable ? 'Search' : 'Apply filter'}</button>
      <button className="textbtn" type="button" onClick={() => { setPeriod('all'); setDraft(emptyFilters); onApply(emptyFilters); }}>Clear</button>
    </div>
  </form>;
}
