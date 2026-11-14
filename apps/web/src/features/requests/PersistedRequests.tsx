import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CreateRequestBodySchema, CreateRequestResponseSchema, RequestDetailSchema, RequestListResponseSchema,
  WorkflowCategorySchema, WorkflowStatusSchema, WorkflowResponseSchema,
  type RequestDetail, type RequestListResponse, type UserResponse, type WorkflowResponse,
} from '@flowpilot/contracts';
import { apiRequest, errorMessage } from '../../lib/api';
import { CrudTable } from '../../components/CrudTable';
import { RecordDetails } from '../../components/RecordDetails';

export function PersistedRequests({ user }: { user: UserResponse }) {
  const [result, setResult] = useState<RequestListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [rawText, setRawText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<RequestDetail | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowResponse | null>(null);
  const [reading, setReading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const submission = useRef<{ rawText: string; key: string } | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setListError('');
    const query = new URLSearchParams({ page: String(page), pageSize: '10' });
    if (search.trim()) query.set('search', search.trim());
    if (status) query.set('status', status);
    if (category) query.set('category', category);
    void apiRequest('/requests?' + query, RequestListResponseSchema, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setResult(data); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setListError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, status, category, page, refresh]);

  async function viewRequest(id: string) {
    setReading(true); setDetailError(''); setSelected(null); setWorkflow(null);
    try { setSelected(await apiRequest('/requests/' + id, RequestDetailSchema)); }
    catch (error) { setDetailError(errorMessage(error)); }
    finally { setReading(false); }
  }
  async function viewWorkflow(id: string) {
    setReading(true); setDetailError('');
    try { setWorkflow(await apiRequest('/workflows/' + id, WorkflowResponseSchema)); }
    catch (error) { setDetailError(errorMessage(error)); }
    finally { setReading(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current) return;
    const parsed = CreateRequestBodySchema.safeParse({ rawText });
    if (!parsed.success) { setSubmitError('Enter a nonblank message of up to 10,000 characters.'); return; }
    if (submission.current?.rawText !== rawText) submission.current = { rawText, key: crypto.randomUUID() };
    const attempt = submission.current;
    locked.current = true; setSubmitting(true); setSubmitError(''); setNotice('');
    try {
      const created = await apiRequest('/requests', CreateRequestResponseSchema, {
        method: 'POST', body: parsed.data, idempotencyKey: attempt.key,
      });
      submission.current = null; setRawText(''); setSearch(''); setStatus(''); setCategory(''); setPage(1);
      setNotice('Request saved. Workflow status: ' + created.status + '.');
      setRefresh((value) => value + 1);
      await viewRequest(created.requestId);
    } catch (error) {
      setSubmitError(errorMessage(error) + ' Retry unchanged text to reuse the same submission key.');
    } finally { locked.current = false; setSubmitting(false); }
  }

  return <>
    <section aria-labelledby="submit-heading">
      <span className="badge">Synthetic requests</span><h2 id="submit-heading">Create request</h2>
      <p>Saved requests remain available after a restart. Workflows stay pending until processing is implemented.</p>
      <form onSubmit={(event) => { void submit(event); }}>
        <fieldset disabled={submitting}>
          <legend className="sr-only">Submit a synthetic request</legend>
          <label htmlFor="request-message">Request message</label>
          <textarea id="request-message" rows={5} required maxLength={10000} value={rawText} onChange={(event) => {
            setRawText(event.target.value); setSubmitError(''); setNotice('');
          }} aria-describedby="synthetic-hint" />
          <p id="synthetic-hint" className="note">Use synthetic data only. Submitting does not issue refunds or send messages.</p>
          {submitError && <p role="alert" className="error">{submitError}</p>}
          <div className="row-actions"><button type="submit">{submitting ? 'Saving…' : 'Submit request'}</button></div>
        </fieldset>
      </form>
      {notice && <p role="status" className="success">{notice}</p>}
    </section>
    <section aria-labelledby="requests-heading" aria-busy={loading}>
      <div className="section-heading"><div><span className="badge">Phase 1</span><h2 id="requests-heading">Requests</h2></div>
        <button className="secondary" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh list</button></div>
      <p>{user.role === 'CLIENT' ? 'Showing your requests.' : 'Showing requests from all demo users.'}</p>
      <div className="toolbar">
        <label htmlFor="request-search">Search requests</label>
        <input id="request-search" type="search" maxLength={200} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
        <label htmlFor="request-status">Status</label>
        <select id="request-status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="">All statuses</option>{WorkflowStatusSchema.options.map((value) => <option key={value}>{value}</option>)}
        </select>
        <label htmlFor="request-category">Category</label>
        <select id="request-category" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}>
          <option value="">All categories</option>{WorkflowCategorySchema.options.map((value) => <option key={value}>{value}</option>)}
        </select>
      </div>
      {listError && <p role="alert" className="error">{listError}</p>}
      {loading ? <p role="status">Loading requests…</p> : !listError && result && <>
        {result.items.length === 0 ? <p>No requests found.</p> : <CrudTable
          caption="Saved synthetic requests" records={result.items} getId={(record) => record.id} getLabel={(record) => 'request ' + record.id}
          columns={[
            { key: 'id', heading: 'Request', render: (record) => record.id },
            { key: 'createdAt', heading: 'Submitted', render: (record) => new Date(record.createdAt).toLocaleString() },
            { key: 'status', heading: 'Workflows', render: (record) => record.workflows.map((run) => run.status).join(', ') || 'No workflows' },
          ]} busy={reading || submitting} onView={(record) => { void viewRequest(record.id); }} />}
        <nav className="pagination" aria-label="Request pages">
          <button className="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page} of {Math.max(1, Math.ceil(result.pagination.total / 10))} · {result.pagination.total} requests</span>
          <button className="secondary" disabled={page * 10 >= result.pagination.total} onClick={() => setPage(page + 1)}>Next</button>
        </nav>
      </>}
      {detailError && <p role="alert" className="error">{detailError}</p>}
      {reading && <p role="status">Loading details…</p>}
      {selected && <RecordDetails title="Request details" busy={reading} onClose={() => { setSelected(null); setWorkflow(null); }}
        fields={[
          { label: 'Request ID', value: selected.id }, { label: 'Message', value: selected.rawText },
          { label: 'Submitted', value: new Date(selected.createdAt).toLocaleString() },
          { label: 'Workflows', value: <ul>{selected.workflows.map((run) => <li key={run.id}>
            <span>{run.status} · {run.category ?? 'Unclassified'} </span>
            <button className="secondary" disabled={reading} onClick={() => { void viewWorkflow(run.id); }}>View workflow {run.id}</button>
          </li>)}</ul> },
        ]} />}
      {workflow && <RecordDetails title="Workflow details" busy={reading} onClose={() => setWorkflow(null)}
        fields={[
          { label: 'Workflow ID', value: workflow.id }, { label: 'Status', value: workflow.status },
          { label: 'Category', value: workflow.category ?? 'Unclassified' }, { label: 'Version', value: workflow.version },
          { label: 'Created', value: new Date(workflow.createdAt).toLocaleString() },
          { label: 'Completed', value: workflow.completedAt ? new Date(workflow.completedAt).toLocaleString() : 'Not completed' },
        ]} />}
    </section>
  </>;
}

