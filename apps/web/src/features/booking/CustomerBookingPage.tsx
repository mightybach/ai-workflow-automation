import { useEffect, useRef, useState } from 'react';
import {
  BusinessDateSchema, CustomerSessionResponseSchema, ServiceListResponseSchema, StaffListResponseSchema,
  CustomerAvailabilityResponseSchema, BookingProposalResponseSchema, BookingResponseSchema,
  ConfirmBookingBodySchema, CustomerBookingDraftSchema, CustomerChatResponseSchema, LogoutResponseSchema,
  type CustomerSessionResponse, type ServiceListResponse, type StaffListResponse,
  type CustomerAvailabilityResponse, type BookingProposalResponse, type BookingResponse,
  type CustomerBookingDraft, type BookingPreferences,
} from '@flowpilot/contracts';
import { apiRequest, ApiFailure, errorMessage } from '../../lib/api';
import { ReschedulePanel } from './ReschedulePanel';

const storageKey = 'flowpilot.customer.booking.v1';
const emptyPreferences: BookingPreferences = { serviceId: null, staffId: null, date: null, durationMinutes: null };
const displayDate = (value: string) => value.split('-').reverse().join('-');
function parseDate(value: string) { return BusinessDateSchema.safeParse(/^\d{2}-\d{2}-\d{4}$/.test(value) ? displayDate(value) : ''); }
function localTime(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, timeZoneName: 'shortOffset', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}
function retain(value: CustomerBookingDraft | null) {
  try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(CustomerBookingDraftSchema.parse(value))); else sessionStorage.removeItem(storageKey); }
  catch { throw new Error('This browser cannot save the retry information. Enable session storage before booking.'); }
}
function restored(session: CustomerSessionResponse) {
  try {
    const value = CustomerBookingDraftSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'));
    // A same-identity token rotation can extend expiry. Never discard an
    // uncertain write solely because that timestamp changed: server replay/
    // owned reads establish the actual identity and selection below.
    return value.success && value.data.businessId === session.businessId ? value.data : null;
  } catch { return null; }
}
async function catalog<T>(path: string, schema: { safeParse(value: unknown): { success: true; data: { items: T[]; pagination: { total: number } } } | { success: false } }) {
  const items: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await apiRequest(path + '?pageSize=50&page=' + page, schema);
    items.push(...result.items);
    if (items.length >= result.pagination.total) return items;
  }
  throw new Error('This demo catalog is too large. Contact the demo operator.');
}
const messageOf = (error: unknown) => error instanceof ApiFailure ? errorMessage(error) : error instanceof Error ? error.message : 'Please try again.';

export function CustomerBookingPage() {
  const [session, setSession] = useState<CustomerSessionResponse | null>(null);
  const sessionRef = useRef<CustomerSessionResponse | null>(null);
  const [slug, setSlug] = useState('demo-salon');
  const [services, setServices] = useState<ServiceListResponse['items']>([]);
  const [staff, setStaff] = useState<StaffListResponse['items']>([]);
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState('');
  const [duration, setDuration] = useState(30);
  const [staffId, setStaffId] = useState('');
  const [available, setAvailable] = useState<CustomerAvailabilityResponse | null>(null);
  const [draft, setDraft] = useState<CustomerBookingDraft | null>(null);
  const [proposal, setProposal] = useState<BookingProposalResponse | null>(null);
  const [booking, setBooking] = useState<BookingResponse | null>(null);
  const [cancelReview, setCancelReview] = useState(false);
  const [name, setName] = useState('Synthetic Customer');
  const [email, setEmail] = useState('demo@example.test');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [chatText, setChatText] = useState('');
  const [chat, setChat] = useState<{ sender: string; text: string }[]>([]);
  const [chatPending, setChatPending] = useState<'typing' | 'availability' | null>(null);
  const [chatReady, setChatReady] = useState(false);
  const transcriptRef = useRef<HTMLOListElement | null>(null);
  const appointmentsRef = useRef<HTMLDivElement | null>(null);
  const reviewRef = useRef<HTMLElement | null>(null);
  const [preferences, setPreferences] = useState<BookingPreferences>(emptyPreferences);

  function remember(value: CustomerBookingDraft | null) { retain(value); setDraft(value); }
  function clearSelection() { remember(null); setProposal(null); setBooking(null); setCancelReview(false); setAvailable(null); setError(''); }
  async function recoverProposal(value: CustomerBookingDraft) {
    const result = await apiRequest('/customer/booking-proposals', BookingProposalResponseSchema, { method: 'POST', body: value.proposal.body, idempotencyKey: value.proposal.key });
    if (value.confirmation && value.confirmation.body.proposalId !== result.id) throw new Error('The saved confirmation belongs to a different session. Do not create a replacement booking; contact the demo operator.');
    setNow(Date.now());
    setProposal(result);
  }
  async function establish(value: CustomerSessionResponse) {
    sessionRef.current = value; setSession(value);
    const [offerings, people] = await Promise.all([catalog('/customer/services', ServiceListResponseSchema), catalog('/customer/staff', StaffListResponseSchema)]);
    if (sessionRef.current !== value) return;
    setServices(offerings); setStaff(people); setServiceId(offerings[0]?.id ?? ''); setDate(displayDate(value.today)); setDuration((current) => Math.min(current, value.maxBookingDurationMinutes));
    const saved = restored(value);
    setDraft(saved); setProposal(null); setBooking(null);
    if (saved?.bookingId) setBooking(await apiRequest('/customer/bookings/' + saved.bookingId, BookingResponseSchema));
    else if (saved) await recoverProposal(saved);
    else retain(null);
  }
  useEffect(() => {
    let active = true;
    const expired = () => {
      const hadSession = sessionRef.current !== null;
      sessionRef.current = null; setSession(null); setDraft(null); setProposal(null); setBooking(null); setCancelReview(false);
      setServices([]); setStaff([]); setAvailable(null); setChat([]); setPreferences(emptyPreferences); setChatReady(false); setChatPending(null);
      try { retain(null); } catch { /* Access is still cleared when storage is unavailable. */ }
      if (hadSession) setError('Your customer session expired. Start a new session; no booking is inferred from chat or browser storage.');
    };
    window.addEventListener('flowpilot-customer-session-expired', expired);
    void apiRequest('/customer/session', CustomerSessionResponseSchema).then(async (value) => { if (active) await establish(value); })
      .catch((cause: unknown) => { if (active && !(cause instanceof ApiFailure && cause.status === 401)) setError(messageOf(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; window.removeEventListener('flowpilot-customer-session-expired', expired); };
  }, []);
  useEffect(() => {
    if (!proposal) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [proposal]);
  useEffect(() => {
    if (!session) return;
    // Recheck idle sessions too; server rejection clears transient chat/drafts.
    const timer = window.setInterval(() => { void apiRequest('/customer/session', CustomerSessionResponseSchema).catch(() => { /* A 401 dispatches the scoped expiry event; network failures do not erase pending writes. */ }); }, 60000);
    return () => window.clearInterval(timer);
  }, [session?.expiresAt]);
  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [chat, chatPending]);
  useEffect(() => {
    if (available) { appointmentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); appointmentsRef.current?.focus({ preventScroll: true }); }
  }, [available]);
  useEffect(() => {
    if (proposal) { reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); reviewRef.current?.focus({ preventScroll: true }); }
  }, [proposal]);
  async function refreshSetup() {
    setBusy(true); setError('');
    try { await establish(await apiRequest('/customer/session', CustomerSessionResponseSchema)); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function start() {
    setBusy(true); setError('');
    try { await establish(await apiRequest('/customer/sessions', CustomerSessionResponseSchema, { method: 'POST', body: { businessSlug: slug } })); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function end() {
    setBusy(true); setError('');
    try {
      await apiRequest('/customer/logout', LogoutResponseSchema, { method: 'POST', body: {} });
      sessionRef.current = null; setSession(null); clearSelection(); setChat([]); setPreferences(emptyPreferences); setChatReady(false);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function search(page = 1, selection?: BookingPreferences) {
    const parsed = selection ? BusinessDateSchema.safeParse(selection.date) : parseDate(date);
    if (!parsed.success) { setError('Enter a valid date as dd-mm-yyyy.'); return; }
    setBusy(true); setError(''); setAvailable(null);
    const chosenStaff = selection ? selection.staffId : staffId;
    const query = new URLSearchParams({ date: parsed.data, serviceId: selection?.serviceId ?? serviceId, durationMinutes: String(selection?.durationMinutes ?? duration), page: String(page), pageSize: '10' });
    if (chosenStaff) query.set('staffId', chosenStaff);
    try {
      const result = await apiRequest('/customer/availability?' + query, CustomerAvailabilityResponseSchema);
      setAvailable(result);
      return result;
    }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function select(slot: CustomerAvailabilityResponse['items'][number]) {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const value: CustomerBookingDraft = { businessId: session.businessId, sessionExpiresAt: session.expiresAt,
        proposal: { key: crypto.randomUUID(), body: { slotId: slot.slotId, serviceId: slot.serviceId, durationMinutes: slot.durationMinutes } }, confirmation: null, bookingId: null };
      remember(value); await recoverProposal(value);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function retryProposal() {
    if (!draft) return;
    setBusy(true); setError('');
    try { await recoverProposal(draft); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }
  async function submitConfirmation() {
    if (!draft || !proposal) return;
    setBusy(true); setError('');
    try {
      let attempt = draft;
      if (!attempt.confirmation) {
        const parsed = ConfirmBookingBodySchema.safeParse({ proposalId: proposal.id, customer: { name, email } });
        if (!parsed.success) throw new Error('Use a synthetic customer name and an example.test email.');
        attempt = { ...draft, confirmation: { key: crypto.randomUUID(), body: parsed.data } };
        remember(attempt);
      }
      const confirmed = await apiRequest('/customer/bookings', BookingResponseSchema, {
        method: 'POST', body: attempt.confirmation!.body, idempotencyKey: attempt.confirmation!.key,
      });
      remember({ ...attempt, bookingId: confirmed.id });
      // A replay is an immutable creation snapshot; owned reads show lifecycle changes.
      setBooking(await apiRequest('/customer/bookings/' + confirmed.id, BookingResponseSchema));
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.status === 409 && ['SLOT_UNAVAILABLE', 'PROPOSAL_EXPIRED', 'DURATION_NOT_ALLOWED', 'SELECTION_UNAVAILABLE'].includes(cause.code ?? '')) {
        remember(null); setProposal(null); setAvailable(null);
        setError(messageOf(cause) + ' View availability again and review a fresh selection.');
      } else setError(messageOf(cause) + (draft.confirmation || cause instanceof ApiFailure && (cause.status === 0 || cause.status >= 500) ? ' Retry the same confirmation to check its result; do not start a replacement booking.' : ''));
    } finally { setBusy(false); }
  }
  async function submitCancellation() {
    if (!draft || !booking || busy) return;
    const activeSession = sessionRef.current;
    setBusy(true); setError('');
    let attempt = draft;
    try {
      if (!attempt.cancellation) {
        attempt = { ...draft, cancellation: { key: crypto.randomUUID(), bookingId: booking.id } };
        remember(attempt);
      }
      const cancelled = await apiRequest('/customer/bookings/' + attempt.cancellation!.bookingId + '/cancel', BookingResponseSchema, {
        method: 'POST', body: {}, idempotencyKey: attempt.cancellation!.key,
      });
      if (sessionRef.current !== activeSession) return;
      setBooking(cancelled); remember({ ...attempt, cancellation: undefined }); setCancelReview(false); setAvailable(null);
    } catch (cause) {
      if (sessionRef.current !== activeSession) return;
      if (cause instanceof ApiFailure && [400, 404, 409].includes(cause.status)) {
        remember({ ...attempt, cancellation: undefined }); setCancelReview(false);
        setError(messageOf(cause));
      } else setError(messageOf(cause) + ' Retry the same cancellation to check its result.');
    } finally { setBusy(false); }
  }
  async function sendChat() {
    const activeSession = sessionRef.current;
    if (!chatText.trim() || busy || draft || !activeSession) return;
    const text = chatText; setChatText(''); setBusy(true); setChatPending('typing'); setChatReady(false); setError('');
    setChat((current) => [...current, { sender: 'You', text }].slice(-20));
    try {
      const result = await apiRequest('/customer/chat/messages', CustomerChatResponseSchema, { method: 'POST', body: { message: text, context: preferences }, timeoutMs: 35000 });
      if (sessionRef.current !== activeSession) return;
      if (!result.needsClarification.length) {
        const value = result.selection;
        if (!services.some((service) => service.id === value.serviceId) ||
          value.staffId && !staff.some((person) => person.id === value.staffId) ||
          !value.date || !value.durationMinutes || value.durationMinutes > activeSession.maxBookingDurationMinutes) {
          throw new Error('Booking setup changed. Refresh customer setup before using these preferences.');
        }
        setServiceId(value.serviceId!); setDate(displayDate(value.date)); setDuration(value.durationMinutes); setStaffId(value.staffId ?? ''); setAvailable(null);
        setChatReady(true);
      }
      setPreferences(result.selection);
      setChat((current) => [...current, { sender: result.provider === 'ollama-v1' ? 'AI assistant' : 'Mock assistant', text: result.message }].slice(-20));
      if (!result.needsClarification.length && result.intent === 'VIEW_AVAILABILITY') {
        setChatPending('availability');
        const actual = await search(1, result.selection);
        if (actual && sessionRef.current === activeSession) {
          const first = actual.items[0];
          const text = first ? `I found ${actual.pagination.total} available starts matching your details. The first is ${localTime(first.startAt, first.timezone)} with ${first.staffName}. Choose a time below to review your booking. Availability can change.` :
            'There are no available starts matching these details. Try another date, duration or staff member.';
          setChat((current) => [...current, { sender: 'Booking assistant', text }].slice(-20));
        }
      }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); setChatPending(null); }
  }
  const pending = !!draft?.confirmation && !booking || !!draft?.cancellation || !!draft?.rescheduling;
  const expired = !!proposal && Date.parse(proposal.expiresAt) <= now;
  return <main className="customer-page">
    <p className="eyebrow">FLOWPILOT BOOKING / SYNTHETIC DEMO</p>
    <h1>Find your next appointment.</h1>
    <p>Choose a real available time, review it, then confirm. This demo uses fictional customers only.</p>
    <a href="/">Staff dashboard</a>
    {error && <p role="alert" className="error">{error}</p>}
    {busy && !chatPending && <p role="status">Working…</p>}
    {!session ? <section aria-labelledby="start-customer"><h2 id="start-customer">Start customer session</h2>
      <form onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <label htmlFor="business-slug">Business</label><input id="business-slug" value={slug} disabled={busy} onChange={(event) => setSlug(event.target.value)} required />
        <p className="note">Use demo-salon. No staff login is needed.</p><button disabled={busy}>Start booking</button>
      </form></section> : <>
      <div className="session-bar"><p><strong>{session.businessName}</strong> · {session.timezone} · up to {session.maxBookingDurationMinutes} minutes</p>
        <button className="secondary" disabled={busy} onClick={() => { void refreshSetup(); }}>Refresh customer setup</button>
        <button className="secondary" disabled={busy || pending} onClick={() => { void end(); }}>End customer session</button></div>
      {booking ? <section aria-labelledby="booking-complete"><h2 id="booking-complete">{booking.status === 'CANCELLED' ? 'Appointment cancelled' : 'Appointment confirmed'}</h2>
        <p className="success">Reference: <strong>{booking.reference}</strong></p>
        <p>{booking.serviceName} with {booking.staffName}<br />{localTime(booking.startAt, booking.timezone)} – {localTime(booking.endAt, booking.timezone)} ({booking.timezone})<br />{booking.durationMinutes} minutes · {booking.customer.name}</p>
        <p className="note">Keep this customer session to view the booking. Ending it removes access; the reference alone is not a login.</p>
        {booking.cancelledAt && <p role="status">Cancelled {localTime(booking.cancelledAt, booking.timezone)}. Booking history is retained.</p>}
        {(booking.status === 'CONFIRMED' || draft?.cancellation) && <>
          {!cancelReview && !draft?.cancellation ? <button className="secondary" disabled={busy || !!draft?.rescheduling} onClick={() => setCancelReview(true)}>Review cancellation</button> :
            <div className="schedule-review"><h3>Review cancellation</h3><p>Cancel appointment {booking.reference} shown above? This releases the full appointment. Closed times remain blocked. This demo allows cancellation before the appointment starts.</p>
              <button disabled={busy} onClick={() => { void submitCancellation(); }}>{draft?.cancellation ? 'Retry same cancellation' : 'Confirm cancellation'}</button>
              <button className="secondary" disabled={busy || !!draft?.cancellation} onClick={() => setCancelReview(false)}>Keep appointment</button>
            </div>}
        </>}
        {draft && !cancelReview && (booking.status === 'CONFIRMED' || draft.rescheduling) && <ReschedulePanel key={booking.id} booking={booking} session={session} services={services} staff={staff} draft={draft} busy={busy} onBusy={setBusy} remember={remember}
          isActive={() => sessionRef.current === session} onReplaced={(current, value) => { remember(value); setBooking(current); setAvailable(null); }} />}
        <button disabled={busy || pending} onClick={clearSelection}>Book another appointment</button>
      </section> : <>
        <section aria-labelledby="booking-chat"><h2 id="booking-chat">Booking assistant</h2>
          <p className="note">Try “Haircut tomorrow for 30 minutes with Alex”. I’ll fill in the details and help you find a time. You review and confirm before anything is booked.</p>
          <details className="note"><summary>About this demo</summary><p>Use fictional details only. Replies identify AI or mock mode. Messages go to the server and, in AI mode, its local model. Up to 20 transcript entries stay in browser memory and clear on reload or session end. Chat cannot confirm bookings.</p></details>
          <ol ref={transcriptRef} className="chat-transcript" aria-label="Chat messages" aria-live="polite">{chat.map((item, index) => <li className={item.sender === 'You' ? 'chat-message chat-user' : 'chat-message chat-assistant'} key={index}><strong>{item.sender}: </strong>{item.text}</li>)}</ol>
          {chatPending && <p className="assistant-typing" role="status"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{chatPending === 'typing' ? 'Assistant is typing…' : 'Checking available appointments…'}</p>}
          {chatReady && !draft && <div className="chat-booking-action">
            <p><strong>{services.find((item) => item.id === serviceId)?.name}</strong> · {date} · {duration} minutes · {staff.find((item) => item.id === staffId)?.displayName ?? 'Any staff'}</p>
            <button disabled={busy} onClick={() => { void search(); }}>View available times</button>
            <p className="note">Choose a time, then review and confirm your booking. Nothing is reserved yet.</p>
          </div>}
          <form onSubmit={(event) => { event.preventDefault(); void sendChat(); }}><label htmlFor="booking-message">Message</label>
            <textarea id="booking-message" maxLength={1000} value={chatText} disabled={busy || !!draft} onChange={(event) => setChatText(event.target.value)} />
            <div className="row-actions"><button disabled={busy || !!draft || !chatText.trim()}>Send message</button></div>
          </form>
        </section>
        <section aria-labelledby="choose-appointment"><h2 id="choose-appointment">Choose appointment details</h2>
          <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
            <fieldset disabled={busy || !!draft} onChange={() => { setAvailable(null); setError(''); setChatReady(false); }}>
              <label htmlFor="booking-service">Service</label><select id="booking-service" value={serviceId} onChange={(event) => setServiceId(event.target.value)} required>
                {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
              </select>
              <div className="booking-fields"><div><label htmlFor="booking-date">Appointment date (dd-mm-yyyy)</label><input id="booking-date" placeholder="dd-mm-yyyy" maxLength={10} value={date} onChange={(event) => setDate(event.target.value)} required /></div>
                <div><label htmlFor="booking-duration">Duration</label><select id="booking-duration" value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                  {Array.from({ length: session.maxBookingDurationMinutes / 30 }, (_, index) => (index + 1) * 30).map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
                </select></div></div>
              <label htmlFor="booking-staff">Preferred staff</label><select id="booking-staff" value={staffId} onChange={(event) => setStaffId(event.target.value)}><option value="">Any staff</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select>
              <div className="row-actions"><button disabled={!serviceId}>View appointments</button></div>
            </fieldset>
          </form>
          {available && !draft && <div ref={appointmentsRef} tabIndex={-1} aria-label="Available appointments">
            <p>{available.pagination.total} available starts · {available.timezone}. Availability is not a hold.</p>
            {available.items.length === 0 ? <p>No appointments match. Choose another date, duration or staff member.</p> : <ul className="appointment-options">{available.items.map((slot) => <li key={slot.slotId}>
              <button className="secondary" disabled={busy} onClick={() => { void select(slot); }}>Select {slot.staffName} {localTime(slot.startAt, slot.timezone)}</button><span>{slot.durationMinutes} minutes · ends {localTime(slot.endAt, slot.timezone)}</span>
            </li>)}</ul>}
            <nav className="pagination" aria-label="Appointment pages"><button disabled={busy || available.pagination.page === 1} onClick={() => { void search(available.pagination.page - 1); }}>Previous appointments</button>
              <span>Page {available.pagination.page} of {Math.max(1, Math.ceil(available.pagination.total / 10))}</span>
              <button disabled={busy || available.pagination.page * 10 >= available.pagination.total} onClick={() => { void search(available.pagination.page + 1); }}>Next appointments</button></nav>
          </div>}
        </section>
        {draft && !proposal && <section><h2>Recover selected appointment</h2><button disabled={busy} onClick={() => { void retryProposal(); }}>Retry selection</button>
          {!pending && <button className="secondary" disabled={busy} onClick={clearSelection}>Choose another appointment</button>}</section>}
        {proposal && <section ref={reviewRef} tabIndex={-1} aria-labelledby="review-appointment"><h2 id="review-appointment">Review appointment</h2>
          <p><strong>{proposal.serviceName}</strong> with <strong>{proposal.staffName}</strong><br />{localTime(proposal.startAt, proposal.timezone)} – {localTime(proposal.endAt, proposal.timezone)}<br />{proposal.durationMinutes} minutes · {proposal.timezone}</p>
          <p className={expired ? 'error' : 'note'}>{expired ? 'Proposal expired. Choose another appointment, unless you are retrying an already submitted confirmation.' : 'Proposal expires ' + localTime(proposal.expiresAt, proposal.timezone) + '. No slots are held yet.'}</p>
          <form onSubmit={(event) => { event.preventDefault(); void submitConfirmation(); }}>
            <label htmlFor="customer-name">Synthetic customer name</label><input id="customer-name" maxLength={120} value={draft?.confirmation?.body.customer.name ?? name} disabled={busy || pending} onChange={(event) => setName(event.target.value)} required />
            <label htmlFor="customer-email">Synthetic email (example.test)</label><input id="customer-email" type="email" maxLength={254} value={draft?.confirmation?.body.customer.email ?? email} disabled={busy || pending} onChange={(event) => setEmail(event.target.value)} required />
            <p className="note">Confirming reserves this exact appointment for the synthetic customer above. The server rechecks availability.</p>
            <div className="row-actions"><button disabled={busy || expired && !pending}>{pending ? 'Retry same confirmation' : 'Confirm booking'}</button>
              <button type="button" className="secondary" disabled={busy || pending} onClick={clearSelection}>Choose another appointment</button></div>
          </form>
        </section>}
      </>}
    </>}
  </main>;
}
