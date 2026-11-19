import { useEffect, useState } from 'react';
import { AdminBookingListSchema, AdminAuditListSchema, AdminCancellationResultSchema, AdminCancellationDraftSchema, BookingResponseSchema, BusinessDateSchema,
  type AdminBookingList, type AdminAuditList, type BookingResponse, type AdminCancellationDraft, type StaffListResponse } from '@flowpilot/contracts';
import { apiRequest, ApiFailure, errorMessage } from '../../lib/api';
const display = (value: string) => value.split('-').reverse().join('-');
const iso = (value: string) => /^\d{2}-\d{2}-\d{4}$/.test(value) ? display(value) : '';
export function BookingAdministration({ businessId, actorId, role, today, timezone, staff, onSaved }: {
  businessId: string; actorId: string; role: 'OWNER' | 'STAFF'; today: string; timezone: string; staff: StaffListResponse['items']; onSaved(): void;
}) {
  const storageKey = `flowpilot.owner.cancellation.v1:${businessId}:${actorId}`;
  const [date, setDate] = useState(display(today)); const [staffId, setStaffId] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const [bookings, setBookings] = useState<AdminBookingList | null>(null); const [audit, setAudit] = useState<AdminAuditList | null>(null);
  const [auditId, setAuditId] = useState(''); const [auditDate, setAuditDate] = useState(''); const [auditPage, setAuditPage] = useState(1);
  const [selected, setSelected] = useState<BookingResponse | null>(null); const [attempt, setAttempt] = useState<AdminCancellationDraft | null>(null);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [auditLoading, setAuditLoading] = useState(true); const [reload, setReload] = useState(0);
  const [error, setError] = useState(''); const [auditError, setAuditError] = useState(''); const [notice, setNotice] = useState('');
  const time = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset', hourCycle: 'h23' }).format(new Date(value)).replaceAll('/', '-');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    if (date && !BusinessDateSchema.safeParse(iso(date)).success) { setError('Enter a valid booking date as dd-mm-yyyy, or leave it empty for all dates.'); setBookings(null); setLoading(false); return; }
    const query = new URLSearchParams({ page: String(page), pageSize: '10', ...(date ? { date: iso(date) } : {}), ...(staffId ? { staffId } : {}), ...(status ? { status } : {}) });
    void apiRequest('/admin/bookings?' + query, AdminBookingListSchema, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setBookings(value); }).catch((cause: unknown) => { if (!controller.signal.aborted) { setBookings(null); setError(errorMessage(cause)); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, staffId, status, page, reload]);
  useEffect(() => {
    const controller = new AbortController(); setAuditLoading(true); setAuditError('');
    if (auditDate && !BusinessDateSchema.safeParse(iso(auditDate)).success) { setAuditError('Enter a valid audit date as dd-mm-yyyy.'); setAudit(null); setAuditLoading(false); return; }
    const query = new URLSearchParams({ page: String(auditPage), pageSize: '10', ...(auditDate ? { date: iso(auditDate) } : {}), ...(auditId ? { bookingId: auditId } : {}) });
    void apiRequest('/admin/audit-events?' + query, AdminAuditListSchema, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setAudit(value); }).catch((cause: unknown) => { if (!controller.signal.aborted) { setAudit(null); setAuditError(errorMessage(cause)); } }).finally(() => { if (!controller.signal.aborted) setAuditLoading(false); });
    return () => controller.abort();
  }, [auditDate, auditId, auditPage, reload]);
  useEffect(() => {
    if (role !== 'OWNER') return;
    let active = true;
    try { const value = AdminCancellationDraftSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'));
      if (value.success && value.data.businessId === businessId && value.data.actorId === actorId) {
        setAttempt(value.data); setBusy(true);
        void apiRequest('/admin/bookings/' + value.data.bookingId, BookingResponseSchema).then((row) => { if (active) setSelected(row); }).catch((cause: unknown) => { if (active) setError(errorMessage(cause)); }).finally(() => { if (active) setBusy(false); });
      }
    } catch { setError('Retry storage is unavailable. Enable session storage before cancelling.'); }
    return () => { active = false; };
  }, [businessId, actorId, role, storageKey]);
  async function cancel() {
    if (!selected && !attempt || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = attempt ?? AdminCancellationDraftSchema.parse({ businessId, actorId, bookingId: selected!.id, key: crypto.randomUUID() });
      sessionStorage.setItem(storageKey, JSON.stringify(value)); setAttempt(value);
      const result = await apiRequest('/admin/bookings/' + value.bookingId + '/cancel', AdminCancellationResultSchema, { method: 'POST', body: {}, idempotencyKey: value.key });
      sessionStorage.removeItem(storageKey); setAttempt(null); setSelected(null); setNotice(`Appointment ${result.reference} cancelled. History retained.`); setReload((n) => n + 1); onSaved();
    } catch (cause) {
      if (cause instanceof ApiFailure && [400, 404, 409].includes(cause.status)) { try { sessionStorage.removeItem(storageKey); setAttempt(null); setSelected(null); } catch { /* Retain the stable retry if storage cannot be cleared. */ } }
      setError(cause instanceof Error ? cause.message : errorMessage(cause));
    } finally { setBusy(false); }
  }
  const locked = busy || !!attempt || !!selected;
  return <section aria-labelledby="booking-admin-heading"><div className="section-heading"><h3 id="booking-admin-heading">Bookings and history</h3><button className="secondary" disabled={busy || loading} onClick={() => setReload((n) => n + 1)}>Refresh bookings and history</button></div>
    <p className="note">Times use {timezone}. Owners can review cancellation before the appointment starts. Staff can inspect bookings and redacted audit history.</p>
    <label htmlFor="admin-booking-date">Booking date (dd-mm-yyyy, empty for all)</label><input id="admin-booking-date" value={date} disabled={locked} maxLength={10} onChange={(event) => { setDate(event.target.value); setPage(1); }} />
    <label htmlFor="admin-booking-staff">Booking staff</label><select id="admin-booking-staff" value={staffId} disabled={locked} onChange={(event) => { setStaffId(event.target.value); setPage(1); }}><option value="">All staff</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select>
    <label htmlFor="admin-booking-status">Booking status</label><select id="admin-booking-status" value={status} disabled={locked} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="CONFIRMED">Confirmed</option><option value="CANCELLED">Cancelled</option></select>
    {error && <p role="alert" className="error">{error}{attempt && ' Retry the same business cancellation to check its result.'}</p>}{notice && <p role="status" className="success">{notice}</p>}
    {(selected || attempt) && <div className="schedule-review"><h4>Review business cancellation</h4>{selected && <p>{selected.reference} · {selected.customer.name}<br />{selected.serviceName} with {selected.staffName}<br />{time(selected.startAt)} – {time(selected.endAt)}<br />Current status: {selected.status}</p>}
      <p>Cancel this exact appointment? All its slots are released together; closed or inactive-staff times remain blocked.</p>
      <button disabled={busy} onClick={() => { void cancel(); }}>{attempt ? 'Retry same business cancellation' : 'Confirm business cancellation'}</button><button className="secondary" disabled={busy || !!attempt} onClick={() => setSelected(null)}>Keep business appointment</button></div>}
    {loading ? <p role="status">Loading bookings…</p> : bookings && <>
      {!bookings.items.length ? <p>No bookings match these filters.</p> : <ul className="setup-list">{bookings.items.map((row) => <li key={row.id}><div><strong>{row.reference}</strong> · {row.status}<br />{row.serviceName} with {row.staffName} · {row.customer.name}<br />{time(row.startAt)} – {time(row.endAt)}<br />
        {role === 'OWNER' && row.status === 'CONFIRMED' && <button className="secondary" disabled={locked} onClick={() => { setSelected(row); setError(''); setNotice(''); }}>Review cancellation for {row.reference}</button>}
        <button className="secondary" disabled={busy} onClick={() => { setAuditId(row.id); setAuditPage(1); }}>View history for {row.reference}</button>
        {row.rescheduledFromId && <button className="secondary" disabled={busy} onClick={() => { setAuditId(row.rescheduledFromId!); setAuditPage(1); }}>View previous appointment history</button>}
      </div></li>)}</ul>}
      <nav className="pagination" aria-label="Booking administration pages"><button disabled={locked || page <= 1} onClick={() => setPage((n) => n - 1)}>Previous bookings</button><span>{bookings.pagination.total} bookings · page {page}</span><button disabled={locked || page * 10 >= bookings.pagination.total} onClick={() => setPage((n) => n + 1)}>Next bookings</button></nav>
    </>}
    <h4>Audit history</h4><label htmlFor="admin-audit-date">Audit date (dd-mm-yyyy, empty for all)</label><input id="admin-audit-date" value={auditDate} maxLength={10} disabled={busy} onChange={(event) => { setAuditDate(event.target.value); setAuditPage(1); }} />
    {auditId && <button className="secondary" disabled={busy} onClick={() => { setAuditId(''); setAuditPage(1); }}>Show all business history</button>}
    {auditError && <p role="alert" className="error">{auditError}</p>}{auditLoading ? <p role="status">Loading audit history…</p> : audit && <>
      {!audit.items.length ? <p>No audit events match this view.</p> : <ul className="setup-list">{audit.items.map((event) => <li key={event.id}><div><strong>{event.eventType}</strong> · {event.actorType}<br />{time(event.createdAt)}<br /><span className="note">Trace: {event.traceId}</span></div></li>)}</ul>}
      <nav className="pagination" aria-label="Audit history pages"><button disabled={busy || auditPage <= 1} onClick={() => setAuditPage((n) => n - 1)}>Previous audit events</button><span>{audit.pagination.total} audit events · page {auditPage}</span><button disabled={busy || auditPage * 10 >= audit.pagination.total} onClick={() => setAuditPage((n) => n + 1)}>Next audit events</button></nav>
    </>}
  </section>;
}
