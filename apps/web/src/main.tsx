import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HealthResponseSchema, SessionResponseSchema, LogoutResponseSchema, type UserResponse } from '@flowpilot/contracts';
import { LoginForm } from './features/auth/LoginForm';
import { PersistedRequests } from './features/requests/PersistedRequests';
import { type DashboardTab, dashboardTabs, dashboardTabFromHash } from './features/business/dashboardTabs';
import { BusinessDashboard } from './features/business/BusinessDashboard';
const CustomerBookingPage = lazy(() => import('./features/booking/CustomerBookingPage').then((module) => ({ default: module.CustomerBookingPage })));
import { apiRequest, errorMessage } from './lib/api';
import './style.css';
import './redesign.css';
import { Icon } from './components/Icon';
import { ThemeToggle, initializeTheme } from './components/ThemeToggle';

initializeTheme();

function App() {
  const [user, setUser] = useState<UserResponse | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authError, setAuthError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>(dashboardTabFromHash);
  useEffect(() => { window.scrollTo(0, 0); }, [activeTab]);
  useEffect(() => { const changed = () => { setActiveTab(dashboardTabFromHash()); setView('business'); }; window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
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
    <div className={'app-shell ' + (!user ? 'signed-out' : '')}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="app-rail" aria-label="Main navigation">
        <a className="brand-mark" href="/" aria-label="FlowPilot home">f<span>p</span></a>
        <nav aria-label="Workspaces">
          {dashboardTabs.filter((tab) => user || tab.id === 'overview').map((tab) => <a key={tab.id} className={view === 'business' && activeTab === tab.id ? 'rail-item active' : 'rail-item'} href={'#' + tab.id} aria-current={view === 'business' && activeTab === tab.id ? 'page' : undefined} onClick={() => { setActiveTab(tab.id); setView('business'); }}><Icon name={tab.icon} /><span>{tab.label}</span></a>)}
          {user && <button className={view === 'legacy' ? 'rail-item active' : 'rail-item'} aria-label="Legacy requests" aria-pressed={view === 'legacy'} onClick={() => setView('legacy')}><Icon name="folder" /><span>Requests</span></button>}
        </nav>
        <a href="/book" className="rail-book" aria-label="Open customer booking"><Icon name="arrow" /></a>
        <span className="rail-monogram" aria-label={user ? 'Signed in' : 'Local demo'}>{user?.email.slice(0, 1).toUpperCase() ?? 'F'}</span>
      </aside>
      <div className="app-workspace">
      <header className="workspace-header"><div><span className="header-breadcrumb">FlowPilot <span>/</span> {view === 'legacy' ? 'Requests' : 'Workspace'}</span><h1>{user ? view === 'legacy' ? 'Legacy requests' : dashboardTabs.find((tab) => tab.id === activeTab)?.label : 'Welcome to FlowPilot'}</h1></div>
        <div className="header-actions"><span className="demo-tag"><i />Local demo</span><ThemeToggle />{user && <button className="secondary" disabled={signingOut} onClick={() => { void signOut(); }}>Sign out</button>}</div>
      </header>
      <main className="workspace-main" id="main-content">
      {authError && <p role="alert" className="error">{authError}</p>}
      {checkingSession ? <p role="status">Checking session…</p> : user ? <>
        {view === 'legacy' && <p className="signed-in-note">{user.email}</p>}
        {view === 'business' ? <BusinessDashboard key={user.id} actorId={user.id} actorEmail={user.email} activeTab={activeTab} /> : <PersistedRequests key={user.id} user={user} />}
      </> : <div className="login-layout"><div className="login-story"><p className="eyebrow">A LITTLE LESS BUSYWORK</p><h2>Good days start<br />with a clear plan.</h2><p>Appointments, your team and the little things in between. Together in one thoughtful workspace.</p><a className="text-link" href="/book">Here for an appointment? <Icon name="arrow" size={18} /></a><div className="login-art" aria-hidden="true"><span className="art-orbit" /><span className="art-tile"><Icon name="calendar" size={36} /></span><span className="art-caption">A little more in flow.</span></div></div><LoginForm onSignIn={(signedIn) => { setAuthError(''); setView('business'); setUser(signedIn); }} /></div>}
      <section className="foundation-status" aria-labelledby="foundation-title">
        <h2 id="foundation-title">Foundation status</h2>
        <p role="status">{status}</p>
        <button onClick={() => { setStatus('Checking API connection…'); setAttempt(attempt + 1); }}>
          Check connection
        </button>
        <p className="note">Synthetic data only. Customer booking and the optional local AI assistant are at /book.</p>
      </section>
      </main></div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(window.location.pathname === '/book' ? <Suspense fallback={<main><p role="status">Loading booking…</p></main>}><CustomerBookingPage /></Suspense> : <App />);


