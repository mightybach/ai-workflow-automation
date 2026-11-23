import { useEffect, useRef, useState } from 'react';
import { AdminBookingListSchema, AdminAuditListSchema, AdminCancellationResultSchema, AdminCancellationDraftSchema, BookingResponseSchema, BusinessDateSchema,
  type AdminBookingList, type AdminAuditList, type BookingResponse, type AdminCancellationDraft, type StaffListResponse } from '@flowpilot/contracts';
import { apiRequest, ApiFailure, errorMessage } from '../../lib/api';
const display = (value: string) => value.split('-').reverse().join('-');
const iso = (value: string) => /^\d{2}-\d{2}-\d{4}$/.test(value) ? display(value) : '';
export function BookingAdministration({ businessId, actorId, role, today, timezone, staff, onSaved, active = true }: {
  businessId: string; actorId: string; role: 'OWNER' | 'STAFF'; today: string; timezone: string; staff: StaffListResponse['items']; onSaved(): void; active?: boolean;
}) {
  const storageKey = `flowpilot.owner.cancellation.v1:${businessId}:${actorId}`;
  const [date, setDate] = useState(display(today)); const [staffId, setStaffId] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState(''); const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false); const [detailId, setDetailId] = useState('');
  const [detail, setDetail] = useState<BookingResponse | null>(null); const [detailLoading, setDetailLoading] = useState(false); const [detailError, setDetailError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false); const dialog = useRef<HTMLDialogElement>(null); const opener = useRef<HTMLElement | null>(null);
  const [bookings, setBookings] = useState<AdminBookingList | null>(null); const [audit, setAudit] = useState<AdminAuditList | null>(null);
  const [auditId, setAuditId] = useState(''); const [auditDate, setAuditDate] = useState(''); const [auditPage, setAuditPage] = useState(1);
  const [selected, setSelected] = useState<BookingResponse | null>(null); const [attempt, setAttempt] = useState<AdminCancellationDraft | null>(null);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [auditLoading, setAuditLoading] = useState(true); const [reload, setReload] = useState(0);
  const [error, setError] = useState(''); const [auditError, setAuditError] = useState(''); const [notice, setNotice] = useState('');
  const time = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset', hourCycle: 'h23' }).format(new Date(value)).replaceAll('/', '-');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    if (date && !BusinessDateSchema.safeParse(iso(date)).success) { setError('Enter a valid booking date as dd-mm-yyyy, or leave it empty for all dates.'); setBookings(null); setLoading(false); return; }
    const query = new URLSearchParams({ page: String(page), pageSize: '10', ...(date ? { date: iso(date) } : {}), ...(staffId ? { staffId } : {}), ...(status ? { status } : {}), ...(search ? { search } : {}) });
    void apiRequest('/admin/bookings?' + query, AdminBookingListSchema, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setBookings(value); }).catch((cause: unknown) => { if (!controller.signal.aborted) { setBookings(null); setError(errorMessage(cause)); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, staffId, status, search, page, reload]);
  useEffect(() => {
    if (!active || !drawerOpen || !historyOpen) return;
    const controller = new AbortController(); setAuditLoading(true); setAuditError('');
    if (auditDate && !BusinessDateSchema.safeParse(iso(auditDate)).success) { setAuditError('Enter a valid audit date as dd-mm-yyyy.'); setAudit(null); setAuditLoading(false); return; }
    const query = new URLSearchParams({ page: String(auditPage), pageSize: '10', ...(auditDate ? { date: iso(auditDate) } : {}), ...(auditId ? { bookingId: auditId } : {}) });
    void apiRequest('/admin/audit-events?' + query, AdminAuditListSchema, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setAudit(value); }).catch((cause: unknown) => { if (!controller.signal.aborted) { setAudit(null); setAuditError(errorMessage(cause)); } }).finally(() => { if (!controller.signal.aborted) setAuditLoading(false); });
    return () => controller.abort();
  }, [auditDate, auditId, auditPage, reload, drawerOpen, historyOpen, active]);
  useEffect(() => {
    if (role !== 'OWNER') return;
    let active = true;
    try { const value = AdminCancellationDraftSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'));
      if (value.success && value.data.businessId === businessId && value.data.actorId === actorId) {
        setAttempt(value.data); setDrawerOpen(true); setDetailId(value.data.bookingId); setBusy(true);
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
      sessionStorage.removeItem(storageKey); setAttempt(null); setSelected(null); setDrawerOpen(false); setDetailId(''); setNotice(`Appointment ${result.reference} cancelled. History retained.`); setReload((n) => n + 1); onSaved();
    } catch (cause) {
      if (cause instanceof ApiFailure && [400, 404, 409].includes(cause.status)) { try { sessionStorage.removeItem(storageKey); setAttempt(null); setSelected(null); } catch { /* Retain the stable retry if storage cannot be cleared. */ } }
      setError(cause instanceof Error ? cause.message : errorMessage(cause));
    } finally { setBusy(false); }
  }
  useEffect(() => {
    const element = dialog.current;
    if (active && drawerOpen && element && !element.open) element.showModal();
    if ((!active || !drawerOpen) && element?.open) { element.close(); if (active) opener.current?.focus(); }
  }, [drawerOpen, active]);
  useEffect(() => {
    if (!active || !drawerOpen || !detailId) { setDetail(null); return; }
    const controller = new AbortController(); setDetailLoading(true); setDetailError(''); setDetail(null);
    void apiRequest('/admin/bookings/' + detailId, BookingResponseSchema, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setDetail(value); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setDetailError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [detailId, drawerOpen, reload, active]);
  function openDetails(row: BookingResponse, history = false, review = false) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetailId(row.id); setDrawerOpen(true); setHistoryOpen(history); setAuditId(row.id); setAuditPage(1); setAuditDate('');
    setSelected(review ? row : null); setError(''); setNotice('');
  }
  function closeDetails() {
    if (busy || attempt) return;
    setDrawerOpen(false); setDetailId(''); setSelected(null);
  }
  const locked = busy || !!attempt || !!selected;
  return <section className="booking-admin" aria-labelledby="booking-admin-heading">
    <div className="section-heading"><div><p className="eyebrow">YOUR APPOINTMENTS</p><h3 id="booking-admin-heading">Bookings and history</h3></div><div className="row-actions"><button className="secondary" disabled={busy || loading} onClick={() => setReload((n) => n + 1)}>Refresh bookings and history</button><button className="secondary" disabled={locked} onClick={() => { opener.current = document.activeElement as HTMLElement; setDetailId(''); setHistoryOpen(true); setAuditId(''); setAuditDate(''); setAuditPage(1); setDrawerOpen(true); }}>View business history</button></div></div>
    <p className="note">Times use {timezone}. Open an appointment for details and history. Cancellation requires owner review.</p>
    <form className="booking-filters" onSubmit={(event) => { event.preventDefault(); if (!locked) { setSearch(searchDraft.trim()); setPage(1); } }}>
      <div className="booking-search"><label htmlFor="admin-booking-search">Search customer or reference</label><div><input id="admin-booking-search" type="search" value={searchDraft} maxLength={100} placeholder="Customer name or booking reference" disabled={locked} onChange={(event) => setSearchDraft(event.target.value)} /><button disabled={locked}>Search bookings</button></div></div>
      <div><label htmlFor="admin-booking-date">Booking date (dd-mm-yyyy, empty for all)</label><input id="admin-booking-date" value={date} placeholder="dd-mm-yyyy" disabled={locked} maxLength={10} onChange={(event) => { setDate(event.target.value); setPage(1); }} /></div>
      <div><label htmlFor="admin-booking-staff">Booking staff</label><select id="admin-booking-staff" value={staffId} disabled={locked} onChange={(event) => { setStaffId(event.target.value); setPage(1); }}><option value="">All staff</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></div>
      <div><label htmlFor="admin-booking-status">Booking status</label><select id="admin-booking-status" value={status} disabled={locked} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="CONFIRMED">Confirmed</option><option value="CANCELLED">Cancelled</option></select></div>
      <button className="secondary booking-clear" type="button" disabled={locked} onClick={() => { setDate(''); setStaffId(''); setStatus(''); setSearch(''); setSearchDraft(''); setPage(1); }}>Clear filters</button>
    </form>
    {search && <p className="note">Searching names and references for “{search}”. Date, staff and status filters also apply.</p>}
    {!drawerOpen && error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="success">{notice}</p>}
    <div aria-busy={loading}>
    {loading ? <p role="status">Loading bookings…</p> : bookings && <>
      <p className="booking-result-count" role="status">{bookings.pagination.total} {bookings.pagination.total === 1 ? 'appointment' : 'appointments'} found</p>
      {!bookings.items.length ? <div className="booking-empty"><h4>No appointments found</h4><p>No bookings match these filters. Try a different date or clear your filters.</p></div> : <ul className="booking-record-list">{bookings.items.map((row) => <li key={row.id} className="booking-record">
        <div className="booking-record-heading"><div><strong>{row.customer.name}</strong><p>{row.serviceName} <span className="note">with {row.staffName}</span></p></div><span className={'booking-status booking-status-' + row.status.toLowerCase()}>{row.status === 'CONFIRMED' ? 'Confirmed' : 'Cancelled'}</span></div>
        <p className="booking-record-time">{time(row.startAt)} – {time(row.endAt)}</p><p className="note booking-reference">{row.reference}{row.rescheduledFromId && ' · Rescheduled appointment'}</p>
        <div className="row-actions booking-record-actions"><button aria-label={'View details for ' + row.reference} disabled={locked} onClick={() => openDetails(row)}>View details</button>
          {role === 'OWNER' && row.status === 'CONFIRMED' && <button className="secondary" aria-label={'Review cancellation for ' + row.reference} disabled={locked} onClick={() => openDetails(row, false, true)}>Review cancellation</button>}
          <button className="secondary" aria-label={'View history for ' + row.reference} disabled={locked} onClick={() => openDetails(row, true)}>View history</button>
        </div>
      </li>)}</ul>}
      <nav className="pagination" aria-label="Booking administration pages"><button disabled={locked || page <= 1} onClick={() => setPage((n) => n - 1)}>Previous bookings</button><span>{bookings.pagination.total} bookings · page {page} of {Math.max(1, Math.ceil(bookings.pagination.total / 10))}</span><button disabled={locked || page * 10 >= bookings.pagination.total} onClick={() => setPage((n) => n + 1)}>Next bookings</button></nav>
    </>}
    </div>
    <dialog className="booking-drawer" ref={dialog} aria-labelledby="booking-detail-title" onCancel={(event) => { event.preventDefault(); closeDetails(); }}>
      <div className="booking-drawer-heading"><div><p className="eyebrow">APPOINTMENT WORKSPACE</p><h4 id="booking-detail-title">{detailId || attempt ? 'Booking details' : 'Business history'}</h4></div><button className="secondary" aria-label="Close booking details" disabled={busy || !!attempt} onClick={closeDetails}>Close</button></div>
      {error && <p role="alert" className="error">{error}{attempt && ' Retry the same business cancellation to check its result.'}</p>}
      {attempt && <p role="status" className="note">A cancellation result needs checking. Use the same retry before closing this panel.</p>}
      {detailLoading && <p role="status">Loading booking details…</p>}{detailError && <div><p role="alert" className="error">{detailError}</p><button className="secondary" disabled={busy} onClick={() => setReload((n) => n + 1)}>Retry booking details</button></div>}
      {detail && <div className="booking-detail-content"><span className={'booking-status booking-status-' + detail.status.toLowerCase()}>{detail.status === 'CONFIRMED' ? 'Confirmed' : 'Cancelled'}</span><h5>{detail.serviceName}</h5><p className="note">{detail.reference}</p><dl className="booking-detail-fields"><dt>Customer</dt><dd>{detail.customer.name}</dd><dt>Email</dt><dd>{detail.customer.email}</dd><dt>Staff member</dt><dd>{detail.staffName}</dd><dt>Starts</dt><dd>{time(detail.startAt)}</dd><dt>Ends</dt><dd>{time(detail.endAt)}</dd><dt>Duration</dt><dd>{detail.durationMinutes} minutes</dd></dl>
        {!selected && !attempt && <div className="row-actions">{role === 'OWNER' && detail.status === 'CONFIRMED' && <button className="secondary" onClick={() => setSelected(detail)}>Review business cancellation</button>}<button className="secondary" onClick={() => { setHistoryOpen(true); setAuditId(detail.id); setAuditPage(1); }}>View appointment history</button></div>}
        {detail.rescheduledFromId && <div className="row-actions"><button className="secondary" disabled={busy || !!attempt} onClick={() => { setHistoryOpen(true); setAuditId(detail.rescheduledFromId!); setAuditPage(1); }}>View previous appointment history</button></div>}
      </div>}
      {(selected || attempt) && <div className="schedule-review"><h4>Review business cancellation</h4>{selected && <p>{selected.reference} · {selected.customer.name}<br />{selected.serviceName} with {selected.staffName}<br />{time(selected.startAt)} – {time(selected.endAt)}<br />Current status: {selected.status}</p>}
        <p>Cancel this exact appointment? All its slots are released together; closed or inactive-staff times remain blocked.</p>
        <div className="row-actions"><button disabled={busy || (!attempt && (detailLoading || !!detailError))} onClick={() => { void cancel(); }}>{attempt ? 'Retry same business cancellation' : 'Confirm business cancellation'}</button><button className="secondary" disabled={busy || !!attempt} onClick={closeDetails}>Keep business appointment</button></div></div>}
      {historyOpen && <div className="booking-audit"><h4>Audit history</h4><p className="note">{auditId ? 'History for the selected appointment.' : 'History across this business.'} Customer content and internal audit metadata are omitted.</p><label htmlFor="admin-audit-date">Audit date (dd-mm-yyyy, empty for all)</label><input id="admin-audit-date" value={auditDate} maxLength={10} disabled={busy} placeholder="dd-mm-yyyy" onChange={(event) => { setAuditDate(event.target.value); setAuditPage(1); }} />
        {auditId && <div className="row-actions"><button className="secondary" disabled={busy} onClick={() => { setAuditId(''); setAuditPage(1); }}>Show all business history</button></div>}
        {auditError && <p role="alert" className="error">{auditError}</p>}{auditLoading ? <p role="status">Loading audit history…</p> : audit && <>
          {!audit.items.length ? <p>No audit events match this view.</p> : <ul className="setup-list">{audit.items.map((event) => <li key={event.id}><div><strong>{event.eventType}</strong> ? {event.actorType}<br />{time(event.createdAt)}<br /><span className="note">Trace: {event.traceId}</span></div></li>)}</ul>}
          <nav className="pagination" aria-label="Audit history pages"><button disabled={busy || auditPage <= 1} onClick={() => setAuditPage((n) => n - 1)}>Previous audit events</button><span>{audit.pagination.total} audit events · page {auditPage}</span><button disabled={busy || auditPage * 10 >= audit.pagination.total} onClick={() => setAuditPage((n) => n + 1)}>Next audit events</button></nav>
        </>}
      </div>}
    </dialog>
  </section>;
}
