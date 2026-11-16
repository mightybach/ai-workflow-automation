import { useState, useRef, type FormEvent } from 'react';
import { LoginBodySchema, SessionResponseSchema, type UserResponse } from '@flowpilot/contracts';
import { apiRequest, errorMessage } from '../../lib/api';

export function LoginForm({ onSignIn }: { onSignIn(user: UserResponse): void }) {
  const [email, setEmail] = useState('owner@flowpilot.test');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current) return;
    const parsed = LoginBodySchema.safeParse({ email, password });
    if (!parsed.success) { setError('Enter a valid email and password.'); return; }
    locked.current = true; setBusy(true); setError('');
    try {
      const result = await apiRequest('/auth/login', SessionResponseSchema, { method: 'POST', body: parsed.data });
      setPassword(''); onSignIn(result.user);
    } catch (error) { setError(errorMessage(error)); }
    finally { locked.current = false; setBusy(false); }
  }
  return <section aria-labelledby="login-heading">
    <span className="badge">Local demo</span><h2 id="login-heading">Sign in</h2>
    <p>Use owner@flowpilot.test or staff@flowpilot.test with the seeded demo password. All data is synthetic.</p>
    <form onSubmit={(event) => { void submit(event); }}>
      <fieldset disabled={busy}>
        <legend className="sr-only">Demo credentials</legend>
        <label htmlFor="login-email">Email</label>
        <input id="login-email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
        <label htmlFor="login-password">Password</label>
        <input id="login-password" type="password" autoComplete="current-password" required maxLength={200} value={password} onChange={(event) => setPassword(event.target.value)} />
        {error && <p role="alert" className="error">{error}</p>}
        <div className="row-actions"><button type="submit">{busy ? 'Signing in…' : 'Sign in'}</button></div>
      </fieldset>
    </form>
  </section>;
}

