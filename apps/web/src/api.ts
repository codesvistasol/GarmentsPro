const root = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

export let base = root;
export function setBranch(id: string) {
  base = id ? root + '/branch/' + encodeURIComponent(id) : root;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch((path.startsWith('/auth/') || /^\/locations(?:\/|$)/.test(path) ? root : base) + path, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('garmentpro-session-expired'));
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    const fields = Object.values(body.details?.fieldErrors ?? {}).flat().join(' ');
    throw new Error(fields || body.details?.formErrors?.join(' ') || body.error || 'Request failed');
  }
  return response.status === 204 ? undefined as T : await response.json();
}

export function send<T>(path: string, method: string, data?: unknown) {
  return api<T>(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });
}
