import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HealthResponseSchema } from '@flowpilot/contracts';
import { RequestWorkspace } from './features/requests/RequestWorkspace';
import { createDraftStore } from './features/requests/draft-store';
import './style.css';

const draftStore = createDraftStore();

function App() {
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
      <p className="eyebrow">FLOWPILOT / DEVELOPMENT</p>
      <h1>A foundation for dependable workflows.</h1>
      <p>Submit, review and track synthetic requests — one validated step at a time.</p>
      <RequestWorkspace store={draftStore} />
      <section aria-labelledby="foundation-title">
        <span className="badge">Phase 0</span>
        <h2 id="foundation-title">Foundation status</h2>
        <p role="status">{status}</p>
        <button onClick={() => { setStatus('Checking API connection…'); setAttempt(attempt + 1); }}>
          Check connection
        </button>
        <p className="note">Synthetic data and mock systems only. Request processing and approvals are planned.</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);


