import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HealthResponseSchema, SessionResponseSchema, LogoutResponseSchema, type UserResponse } from '@flowpilot/contracts';
import { LoginForm } from './features/auth/LoginForm';
import { PersistedRequests } from './features/requests/PersistedRequests';
import { BusinessDashboard } from './features/business/BusinessDashboard';
const CustomerBookingPage = lazy(() => import('./features/booking/CustomerBookingPage').then((module) => ({ default: module.CustomerBookingPage })));
import { apiRequest, errorMessage } from './lib/api';
import './style.css';

function App() {
  const [user, setUser] = useState<UserResponse | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authError, setAuthError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [view, setView] = useState<'business' | 'legacy'>('business');
  useEffect(() => {
    const controller = new AbortController();
    const expired = () => { setUser(null); setView('business'); };
    window.addEventListener('flowpilot-session-expired', expired);
    void apiRequest('/auth/me', SessionResponseSchema, { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setUser(response.user); })
      .catch((error: unknown) => { if (!controller.signal.aborted && !(error instanceof Error && 'status' in error && error.status === 401)) setAuthError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setCheckingSession(false); });
    return () => { controller.abort(); window.removeEventListener('flowpilot-session-expired', expired); };
  }, []);
  async function signOut() {
    setSigningOut(true); setAuthError('');
    try { await apiRequest('/auth/logout', LogoutResponseSchema, { method: 'POST' }); setUser(null); setView('business'); }
    catch (error) { setAuthError(errorMessage(error)); }
    finally { setSigningOut(false); }
  }
  const [status, setStatus] = useState('Checking API connection…');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    void fetch('/api/v1/health/live', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('API unavailable');
        HealthResponseSchema.parse(await response.json());
        if (active) setStatus('API connected');
      })
      .catch(() => {
        if (!active) return;
        if (!controller.signal.aborted) setStatus('API unavailable. Check that the API is running.');
        else setStatus('API check timed out. Try again.');
      })
      .finally(() => clearTimeout(timer));
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [attempt]);
  return (
    <main>
      <p className="eyebrow">FLOWPILOT BOOKING / LOCAL DEMO</p>
      <h1>Your salon, ready to plan.</h1>
      <p>Inspect your team, services and 30-minute slot inventory in one place.</p>
      <p><a href="/book">Book a synthetic appointment</a></p>
      {authError && <p role="alert" className="error">{authError}</p>}
      {checkingSession ? <p role="status">Checking session…</p> : user ? <>
        <div className="session-bar"><p>Signed in as {user.email}</p><button className="secondary" disabled={signingOut} onClick={() => { void signOut(); }}>Sign out</button></div>
        <nav className="workspace-tabs" aria-label="Workspaces">
          <button className={view === 'business' ? '' : 'secondary'} aria-pressed={view === 'business'} onClick={() => setView('business')}>Business setup</button>
          <button className={view === 'legacy' ? '' : 'secondary'} aria-pressed={view === 'legacy'} onClick={() => setView('legacy')}>Legacy requests</button>
        </nav>
        {view === 'business' ? <BusinessDashboard key={user.id} actorId={user.id} /> : <PersistedRequests key={user.id} user={user} />}
      </> : <LoginForm onSignIn={(signedIn) => { setAuthError(''); setView('business'); setUser(signedIn); }} />}
      <section aria-labelledby="foundation-title">
        <span className="badge">Phase 0</span>
        <h2 id="foundation-title">Foundation status</h2>
        <p role="status">{status}</p>
        <button onClick={() => { setStatus('Checking API connection…'); setAttempt(attempt + 1); }}>
          Check connection
        </button>
        <p className="note">Synthetic data only. Customer booking and the optional local AI assistant are at /book.</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(window.location.pathname === '/book' ? <Suspense fallback={<main><p role="status">Loading booking…</p></main>}><CustomerBookingPage /></Suspense> : <App />);


