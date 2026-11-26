import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api';

export function useOrderDetails(selected: string) {
  const details = useRef<HTMLElement>(null);
  function reveal() {
    details.current?.focus({ preventScroll: true });
    details.current?.scrollIntoView({ block: 'start' });
  }
  useEffect(() => { if (selected) reveal(); }, [selected]);
  return { details, reveal };
}

export function useQuery<T>(path: string, initial: T, revision = 0, enabled = true) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<T>(path, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision, enabled]);
  return { data, error, loading };
}

export function QueryStatus({ loading, error }: { loading: boolean; error: string }) {
  return <>{loading && <p className="hint" role="status">Loading…</p>}{error && <p className="error" role="alert">{error}</p>}</>;
}

export function Editor({ title, onClose, onSave, children, save = 'Save' }: {
  title: string;
  onClose: () => void;
  onSave?: () => Promise<void>;
  children: ReactNode;
  save?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const first = dialog.current?.querySelector<HTMLElement>('input, select, button');
    first?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (busy) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [busy]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!onSave) return;
    setBusy(true);
    setError('');
    try {
      await onSave();
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return <div className="backdrop">
    <section className="dialog warehouse-editor" role="dialog" aria-modal="true" aria-label={title} ref={dialog}>
      <div className="modal-head"><h2>{title}</h2></div>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>{children}</fieldset>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>{onSave ? 'Cancel' : 'Close'}</button>
          {onSave && <button className="primary" disabled={busy}>{busy ? 'Saving…' : save}</button>}
        </div>
      </form>
    </section>
  </div>;
}

export type StockVariant = {
  id: string;
  productId: string;
  sku: string;
  size: string;
  color: string;
  availableQty: number;
  reservedQty: number;
  saleActive: boolean;
  reorderPoint: number;
  product: { id: string; sku: string; name: string; archived: boolean; serialNumber: number; salePrice: string; createdAt: string; image?: { productId: string } | null };
};

export function variantLabel(variant: StockVariant) {
  return `${variant.product.name} · ${variant.color} / ${variant.size} (${variant.sku})`;
}

const productPriceFormat = new Intl.NumberFormat('en-PK', {
  style: 'currency', currency: 'PKR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export function formatProductPrice(value: string) {
  return productPriceFormat.format(Number(value));
}
