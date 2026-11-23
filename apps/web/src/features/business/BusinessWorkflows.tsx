import { useEffect, useState } from 'react';
import { BusinessWorkflowPoliciesSchema, BusinessTaskListSchema, BusinessTaskSchema, BusinessWorkflowPolicySchema,
  BusinessWorkflowPendingActionSchema, BusinessEnquiryResultSchema, AdminBookingListSchema, BusinessDateSchema,
  type BusinessWorkflowPolicy, type BusinessTask, type BusinessWorkflowPendingAction } from '@flowpilot/contracts';
import { ApiFailure, apiRequest, errorMessage } from '../../lib/api';

const label = (kind: string) => kind === 'PREPARE_APPOINTMENT' ? 'Appointment preparation' : 'Arrival enquiry follow-up';
const displayDate = (date: string) => date.split('-').reverse().join('-');
const at = (date: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(date));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')}`;
};
export function BusinessWorkflows({ actorId, businessId, role, today, onChanged }: { actorId: string; businessId: string; role: 'OWNER' | 'STAFF'; today: string; onChanged?(): void }) {
  const storageKey = `flowpilot-workflow-action:v1:${actorId}:${businessId}`;
  const [policies, setPolicies] = useState<BusinessWorkflowPolicy[]>([]);
  const [tasks, setTasks] = useState<BusinessTask[]>([]);
  const [page, setPage] = useState(1); const [total, setTotal] = useState(0); const [status, setStatus] = useState('OPEN');
  const [taskDate, setTaskDate] = useState('');
  const [revision, setRevision] = useState(0); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<BusinessWorkflowPendingAction | null>(null);
  const [storageReady, setStorageReady] = useState(false); const [review, setReview] = useState<BusinessWorkflowPendingAction | null>(null);
  const [date, setDate] = useState(displayDate(today)); const [bookingPage, setBookingPage] = useState(1); const [bookingTotal, setBookingTotal] = useState(0);
  const [bookings, setBookings] = useState<{ id: string; reference: string }[]>([]); const [bookingId, setBookingId] = useState('');
  useEffect(() => {
    setStorageReady(false); setPending(null); setReview(null);
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) { const parsed = BusinessWorkflowPendingActionSchema.safeParse(JSON.parse(raw)); if (!parsed.success) throw new Error('Invalid pending request'); setPending(parsed.data); }
      setStorageReady(true);
    } catch { setError('Pending request storage is unavailable or invalid. Workflow writes are blocked in this tab.'); }
  }, [storageKey]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    const filterDate = taskDate ? BusinessDateSchema.safeParse(displayDate(taskDate)) : null;
    if (filterDate && !filterDate.success) { setTasks([]); setTotal(0); setLoading(false); setError('Enter the task date as dd-mm-yyyy, or clear it for all dates.'); return () => controller.abort(); }
    setError((current) => current === 'Enter the task date as dd-mm-yyyy, or clear it for all dates.' ? '' : current);
    void Promise.all([
      apiRequest('/admin/workflows', BusinessWorkflowPoliciesSchema, { signal: controller.signal }),
      apiRequest('/admin/tasks?' + new URLSearchParams({ page: String(page), pageSize: '10', ...(status ? { status } : {}), ...(filterDate?.success ? { date: filterDate.data } : {}) }), BusinessTaskListSchema, { signal: controller.signal }),
    ]).then(([policy, list]) => { if (!controller.signal.aborted) { setPolicies(policy.items); setTasks(list.items); setTotal(list.pagination.total); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, status, taskDate, revision]);
  useEffect(() => {
    setBookings([]); setBookingId('');
    const parsed = BusinessDateSchema.safeParse(displayDate(date)); if (!parsed.success) return;
    const controller = new AbortController();
    void apiRequest('/admin/bookings?' + new URLSearchParams({ date: parsed.data, status: 'CONFIRMED', pageSize: '10', page: String(bookingPage) }), AdminBookingListSchema, { signal: controller.signal })
      .then((list) => { if (!controller.signal.aborted) { setBookings(list.items.filter((item) => Date.parse(item.startAt) > Date.now()).map((item) => ({ id: item.id, reference: item.reference }))); setBookingTotal(list.pagination.total); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [date, bookingPage, revision]);
  async function send(action: BusinessWorkflowPendingAction) {
    if (busy || !storageReady) return;
    try { const value = JSON.stringify(action); sessionStorage.setItem(storageKey, value); if (sessionStorage.getItem(storageKey) !== value) throw new Error('Storage unavailable'); }
    catch { setStorageReady(false); setError('Could not preserve this request safely. Nothing was sent.'); return; }
    setPending(action); setReview(null); setBusy(true); setError(''); setNotice('');
    try {
      const path = action.operation === 'SET_POLICY' ? `/admin/workflows/${action.targetId}` : action.operation === 'COMPLETE_TASK' ? `/admin/tasks/${action.targetId}/complete` : `/admin/bookings/${action.targetId}/enquiry-follow-up`;
      const schema = action.operation === 'SET_POLICY' ? BusinessWorkflowPolicySchema : action.operation === 'COMPLETE_TASK' ? BusinessTaskSchema : BusinessEnquiryResultSchema;
      await apiRequest<unknown>(path, schema, { method: action.operation === 'SET_POLICY' ? 'PUT' : 'POST', body: action.body, idempotencyKey: action.key });
      sessionStorage.removeItem(storageKey); setPending(null); setNotice('Action saved. Refreshing current workflow state.'); setRevision((n) => n + 1); onChanged?.();
    } catch (cause) {
      const definitive = cause instanceof ApiFailure && [400, 404, 409].includes(cause.status);
      if (definitive) { try { sessionStorage.removeItem(storageKey); setPending(null); } catch { setStorageReady(false); } setRevision((n) => n + 1); }
      setError(errorMessage(cause) + (definitive ? ' Refresh and review the latest state.' : ' Result uncertain. Use Retry same action to check it; no automatic retry occurs.'));
    } finally { setBusy(false); }
  }
  const blocked = busy || !!pending || !storageReady || loading;
  const selectedTask = review?.operation === 'COMPLETE_TASK' ? tasks.find((task) => task.id === review.targetId) : null;
  const selectedPolicy = review?.operation === 'SET_POLICY' ? policies.find((policy) => policy.id === review.targetId) : null;
  const selectedBooking = review?.operation === 'RECORD_ENQUIRY' ? bookings.find((booking) => booking.id === review.targetId) : null;
  const reviewVisible = selectedTask || selectedPolicy || selectedBooking;
  return <section aria-labelledby="workflow-heading" aria-busy={busy || loading}>
    <div className="section-heading"><h3 id="workflow-heading">Business workflows</h3><button className="secondary" disabled={busy} onClick={() => setRevision((n) => n + 1)}>Refresh workflows</button></div>
    <p>Internal tasks only. Chat cannot enable workflows or complete work. Tasks are due at the appointment start.</p>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {pending && <div><p role="status">An action is awaiting confirmation of its result. Reloading only reads current state.</p><button disabled={busy || !storageReady} onClick={() => void send(pending)}>Retry same action</button></div>}
    <div className="workflow-policy-grid">{policies.map((policy) => <div className="workflow-policy-card" key={policy.id}><strong>{label(policy.template)}</strong><p className={'policy-state ' + (policy.enabled ? 'is-enabled' : '')}>{policy.enabled ? 'Enabled' : 'Disabled'}</p>
      {role === 'OWNER' ? <button className="secondary" disabled={blocked} onClick={() => setReview({ operation: 'SET_POLICY', targetId: policy.id, key: crypto.randomUUID(), body: { enabled: !policy.enabled, expectedRevision: policy.revision } })}>Review {policy.enabled ? 'disable' : 'enable'} {label(policy.template).toLowerCase()}</button> : <p className="note">Only an OWNER can change this policy.</p>}
    </div>)}</div>
    <h4>Record a synthetic arrival-information enquiry</h4><p>A staff-recorded enquiry creates one follow-up task per booking. No customer text or external message is stored or sent.</p>
    <label htmlFor="workflow-enquiry-date">Enquiry appointment date (dd-mm-yyyy)</label><input id="workflow-enquiry-date" value={date} disabled={busy} onChange={(event) => { setDate(event.target.value); setBookingPage(1); }} placeholder="dd-mm-yyyy" />
    {!BusinessDateSchema.safeParse(displayDate(date)).success && <p className="note">Enter a valid enquiry appointment date as dd-mm-yyyy.</p>}
    <label htmlFor="workflow-enquiry-booking">Enquiry booking</label><select id="workflow-enquiry-booking" value={bookingId} disabled={blocked} onChange={(event) => setBookingId(event.target.value)}><option value="">Select a future booking</option>{bookings.map((booking) => <option key={booking.id} value={booking.id}>{booking.reference}</option>)}</select>
    <div className="row-actions"><button className="secondary" disabled={busy || bookingPage <= 1} onClick={() => setBookingPage((n) => n - 1)}>Previous enquiry bookings</button>
    <button className="secondary" disabled={busy || bookingPage * 10 >= bookingTotal} onClick={() => setBookingPage((n) => n + 1)}>Next enquiry bookings</button>
    <button disabled={blocked || !bookingId || !policies.some((p) => p.template === 'FOLLOW_UP_ENQUIRY' && p.enabled)} onClick={() => setReview({ operation: 'RECORD_ENQUIRY', targetId: bookingId, key: crypto.randomUUID(), body: { topic: 'ARRIVAL_INFORMATION' } })}>Review arrival enquiry</button></div>
    <h4>Tasks</h4><label htmlFor="workflow-task-status">Task status</label><select id="workflow-task-status" value={status} disabled={busy} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All states</option>{['OPEN', 'COMPLETED', 'CANCELLED', 'EXPIRED'].map((state) => <option key={state}>{state}</option>)}</select>
    <label htmlFor="workflow-task-date">Task date (dd-mm-yyyy, empty for all)</label><input id="workflow-task-date" value={taskDate} disabled={busy} placeholder="dd-mm-yyyy" onChange={(event) => { setTaskDate(event.target.value); setPage(1); }} />
    {!loading && !tasks.length && <p>No tasks in this view. New preparation tasks require an enabled policy and the workflow worker.</p>}
    {tasks.map((task) => <article className="workflow-task-card" key={task.id} aria-label={`${label(task.kind)} ${task.bookingReference}`}><h4>{label(task.kind)} · {task.bookingReference}</h4>
      <p>{task.serviceName} with {task.staffName} · {at(task.startAt, task.timezone)} · {task.timezone}</p><p>Status: {task.status}{task.invalidatedAt ? ` · Invalidated: ${task.invalidationReason}` : ''}</p>
      {task.status === 'OPEN' && <button disabled={blocked || Date.parse(task.dueAt) <= Date.now()} onClick={() => setReview({ operation: 'COMPLETE_TASK', targetId: task.id, key: crypto.randomUUID(), body: { expectedRevision: task.revision } })}>Review completion</button>}
    </article>)}
    <nav className="pagination" aria-label="Workflow task pages"><button className="secondary" disabled={busy || page <= 1} onClick={() => setPage((n) => n - 1)}>Previous tasks</button><span> Page {page} · {total} tasks </span><button className="secondary" disabled={busy || page * 10 >= total} onClick={() => setPage((n) => n + 1)}>Next tasks</button></nav>
    {review && <div role="region" aria-label="Review workflow action"><h4>Review workflow action</h4>
      <p>{selectedPolicy ? label(selectedPolicy.template) : selectedTask ? `${label(selectedTask.kind)} · ${selectedTask.bookingReference} · ${at(selectedTask.startAt, selectedTask.timezone)}` : selectedBooking ? `Arrival-information enquiry · ${selectedBooking.reference}` : 'The selected item is no longer in this view. Keep current state, refresh and select it again.'}</p>
      <p>{review.operation === 'SET_POLICY' ? review.body.enabled ? 'Enable this workflow for new work? Historical bookings will not be backfilled.' : 'Disable this workflow? Open tasks will be cancelled and pending runs suppressed.' : review.operation === 'COMPLETE_TASK' ? 'Confirm that you have completed this task. This does not change the booking.' : 'Record one arrival-information enquiry for this booking? Staff will review an internal task; nothing is sent externally.'}</p>
      <div className="row-actions"><button disabled={busy} onClick={() => setReview(null)}>Keep current state</button><button disabled={blocked || !reviewVisible} onClick={() => void send(review)}>Confirm workflow action</button></div></div>}
  </section>;
}
