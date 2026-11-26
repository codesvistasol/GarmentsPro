import { useState, type FormEvent } from 'react';
import { Package } from 'lucide-react';
import { send } from './api';

export type Role = 'ADMIN' | 'WAREHOUSE' | 'SALES' | 'FINANCE';
export type StaffIdentity = { id: string; username: string; displayName: string; role: Role; permissions: string[] };
export const roleNames: Record<Role, string> = {
  ADMIN: 'Administrator', WAREHOUSE: 'Warehouse', SALES: 'Sales', FINANCE: 'Finance',
};

type Mode = 'login' | 'signup' | 'reset';
export function StaffLogin({ onLogin, checking }: { onLogin: (identity: StaffIdentity) => void; checking: boolean }) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  function changeMode(next: Mode) {
    setMode(next);
    setError('');
    setMessage('');
    setPassword('');
    setCode('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') {
        onLogin(await send<StaffIdentity>('/auth/login', 'POST', { username, password }));
      } else if (mode === 'signup') {
        const result = await send<{ message: string }>('/auth/signup', 'POST', { email: username, displayName: name, password });
        changeMode('login');
        setMessage(result.message);
      } else {
        await send('/auth/reset-password', 'POST', { code, password });
        changeMode('login');
        setMessage('Password updated. Sign in with your new password.');
      }
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  const title = { login: 'Sign in to GarmentPro', signup: 'Create a staff account', reset: 'Reset password' }[mode];
  return <main className="staff-login studio-shell">
    <section className="panel staff-login-card">
      <div className="brand-icon"><Package size={22}/></div>
      <h1>{title}</h1>
      {checking ? <p role="status">Checking your session…</p> : <>
        <form key={mode} onSubmit={submit}>
          {mode === 'signup' && <label>Full name<input autoComplete="name" required minLength={2} maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>}
          {mode !== 'reset' && <label>{mode === 'signup' ? 'Email' : 'Username or email'}<input type={mode === 'signup' ? 'email' : 'text'} autoComplete="username" maxLength={254} value={username} required onChange={event => setUsername(event.target.value)} /></label>}
          {mode === 'reset' && <>
            <p>Ask your administrator for a one-time reset code. It expires after 15 minutes.</p>
            <label>Reset code<input autoComplete="one-time-code" required minLength={48} maxLength={48} value={code} onChange={event => setCode(event.target.value)} /></label>
          </>}
          <label>{mode === 'reset' ? 'New password' : 'Password'}<input autoComplete={mode === 'login' ? 'current-password' : 'new-password'} type="password" minLength={mode === 'login' ? undefined : 12} maxLength={128} value={password} required onChange={event => setPassword(event.target.value)} /></label>
          {message && <p role="status">{message}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={busy}>{busy ? 'Please wait…' : { login: 'Sign in', signup: 'Create account', reset: 'Save new password' }[mode]}</button>
        </form>
        <div className="warehouse-actions">
          {mode === 'login' ? <>
            <button className="textbtn" disabled={busy} onClick={() => changeMode('signup')}>Create account</button>
            <button className="textbtn" disabled={busy} onClick={() => changeMode('reset')}>Forgot password?</button>
          </> : <button className="textbtn" disabled={busy} onClick={() => changeMode('login')}>Back to sign in</button>}
        </div>
      </>}
    </section>
  </main>;
}
