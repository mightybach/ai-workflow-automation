import { useEffect, useState } from 'react';
import { BookingProposalResponseSchema, BookingResponseSchema, BusinessDateSchema, CustomerAvailabilityResponseSchema,
  type BookingProposalResponse, type BookingResponse, type CustomerAvailabilityResponse, type CustomerBookingDraft,
  type CustomerSessionResponse, type ServiceListResponse, type StaffListResponse } from '@flowpilot/contracts';
import { apiRequest, ApiFailure, errorMessage } from '../../lib/api';

const display = (value: string) => value.split('-').reverse().join('-');
const time = (value: string, zone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset', hourCycle: 'h23' }).format(new Date(value)).replaceAll('/', '-');
export function ReschedulePanel({ booking, session, services, staff, draft, busy, onBusy, remember, onReplaced, isActive }: {
  booking: BookingResponse; session: CustomerSessionResponse; services: ServiceListResponse['items']; staff: StaffListResponse['items'];
  draft: CustomerBookingDraft; busy: boolean; onBusy(value: boolean): void; remember(value: CustomerBookingDraft): void;
  onReplaced(booking: BookingResponse, draft: CustomerBookingDraft): void;
  isActive(): boolean;
}) {
  const [open, setOpen] = useState(!!draft.rescheduling); const [date, setDate] = useState(display(new Intl.DateTimeFormat('en-CA', { timeZone: booking.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(booking.startAt))));
  const [serviceId, setServiceId] = useState(services.some((item) => item.id === booking.serviceId) ? booking.serviceId : services[0]?.id ?? '');
  const [staffId, setStaffId] = useState(''); const [duration, setDuration] = useState(Math.min(booking.durationMinutes, session.maxBookingDurationMinutes));
  const [available, setAvailable] = useState<CustomerAvailabilityResponse | null>(null); const [proposal, setProposal] = useState<BookingProposalResponse | null>(null); const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const attempt = draft.rescheduling;
  const originalId = attempt?.originalBookingId ?? booking.id;
  async function recover(value = attempt) {
    if (!value?.proposal) return;
    const result = await apiRequest(`/customer/bookings/${value.originalBookingId}/reschedule-proposals`, BookingProposalResponseSchema, { method: 'POST', body: value.proposal.body, idempotencyKey: value.proposal.key });
    if (result.rescheduleOfId !== value.originalBookingId || value.confirmation && value.confirmation.proposalId !== result.id) throw new Error('The saved replacement does not match this booking. Contact the demo operator.');
    setProposal(result);
  }
  useEffect(() => {
    let active = true;
    if (attempt?.proposal) { onBusy(true); void recover().catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : errorMessage(cause)); }).finally(() => { if (active) onBusy(false); }); }
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { active = false; window.clearInterval(timer); };
    // Restore only when this booking panel mounts; later writes manage their own state.
  }, []);
  async function search(page = 1) {
    const iso = /^\d{2}-\d{2}-\d{4}$/.test(date) ? display(date) : '';
    if (!BusinessDateSchema.safeParse(iso).success) { setError('Enter a valid replacement date as dd-mm-yyyy.'); return; }
    onBusy(true); setError('');
    try { const query = new URLSearchParams({ date: iso, serviceId, durationMinutes: String(duration), rescheduleBookingId: originalId, page: String(page), pageSize: '10', ...(staffId ? { staffId } : {}) });
      setAvailable(await apiRequest('/customer/availability?' + query, CustomerAvailabilityResponseSchema));
    } catch (cause) { setError(errorMessage(cause)); } finally { onBusy(false); }
  }
  async function select(slot: CustomerAvailabilityResponse['items'][number]) {
    onBusy(true); setError('');
    try { const value = { originalBookingId: originalId, proposal: { key: crypto.randomUUID(), body: { slotId: slot.slotId, serviceId: slot.serviceId, durationMinutes: slot.durationMinutes } }, confirmation: null };
      remember({ ...draft, rescheduling: value }); await recover(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : errorMessage(cause)); } finally { onBusy(false); }
  }
  async function confirm() {
    if (!attempt || !proposal) return;
    onBusy(true); setError('');
    try {
      const value = attempt.confirmation ? attempt : { ...attempt, confirmation: { key: crypto.randomUUID(), proposalId: proposal.id } };
      remember({ ...draft, rescheduling: value });
      const result = await apiRequest(`/customer/bookings/${originalId}/reschedule`, BookingResponseSchema, { method: 'POST', body: { proposalId: value.confirmation!.proposalId }, idempotencyKey: value.confirmation!.key });
      const current = await apiRequest('/customer/bookings/' + result.id, BookingResponseSchema);
      if (!isActive()) return;
      onReplaced(current, { ...draft, proposal: value.proposal!, confirmation: null, bookingId: current.id, rescheduling: undefined });
    } catch (cause) {
      if (!isActive()) return;
      if (cause instanceof ApiFailure && [400, 404, 409].includes(cause.status)) { remember({ ...draft, rescheduling: undefined }); setProposal(null); setAvailable(null); }
      setError((cause instanceof Error ? cause.message : errorMessage(cause)) + ' Your original is kept unless the server completed the replacement. Use the same retry after an uncertain response.');
    } finally { onBusy(false); }
  }
  function abandon() { remember({ ...draft, rescheduling: undefined }); setProposal(null); setAvailable(null); setError(''); setOpen(false); }
  return <section aria-labelledby="reschedule-heading"><h3 id="reschedule-heading">Reschedule appointment</h3>
    {!open ? <button className="secondary" disabled={busy || !!draft.cancellation} onClick={() => setOpen(true)}>Choose replacement time</button> : <>
      <p className="note">Your original appointment stays booked while you browse and review. Only Confirm rescheduling replaces it. Your own reserved time is included for overlapping moves.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <fieldset disabled={busy || !!attempt?.proposal}>
        <label htmlFor="replacement-date">Replacement date (dd-mm-yyyy)</label><input id="replacement-date" value={date} maxLength={10} onChange={(event) => { setDate(event.target.value); setAvailable(null); }} />
        <label htmlFor="replacement-service">Replacement service</label><select id="replacement-service" value={serviceId} onChange={(event) => { setServiceId(event.target.value); setAvailable(null); }}>{services.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <label htmlFor="replacement-duration">Replacement duration</label><select id="replacement-duration" value={duration} onChange={(event) => { setDuration(Number(event.target.value)); setAvailable(null); }}>{Array.from({ length: session.maxBookingDurationMinutes / 30 }, (_, n) => (n + 1) * 30).map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select>
        <label htmlFor="replacement-staff">Replacement staff</label><select id="replacement-staff" value={staffId} onChange={(event) => { setStaffId(event.target.value); setAvailable(null); }}><option value="">Any staff</option>{staff.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
        <button disabled={!serviceId} onClick={() => { void search(); }}>View replacement times</button>
      </fieldset>
      {available && !attempt?.proposal && <><p>{available.pagination.total} replacement starts available.</p><ul className="appointment-options">{available.items.map((slot) => <li key={slot.slotId}><button className="secondary" disabled={busy} onClick={() => { void select(slot); }}>Review replacement {slot.staffName} {time(slot.startAt, slot.timezone)}</button><span>{slot.durationMinutes} minutes</span></li>)}</ul>
        <button disabled={busy || available.pagination.page <= 1} onClick={() => { void search(available.pagination.page - 1); }}>Previous replacements</button><button disabled={busy || available.pagination.page * 10 >= available.pagination.total} onClick={() => { void search(available.pagination.page + 1); }}>Next replacements</button></>}
      {attempt?.proposal && !proposal && <button disabled={busy} onClick={() => { onBusy(true); void recover().catch((cause: unknown) => setError(errorMessage(cause))).finally(() => onBusy(false)); }}>Retry replacement review</button>}
      {proposal && <div className="schedule-review"><h4>Review replacement appointment</h4><p>Original: {booking.reference}<br />{booking.serviceName} with {booking.staffName}, {time(booking.startAt, booking.timezone)} – {time(booking.endAt, booking.timezone)}</p>
        <p>Replacement: {proposal.serviceName} with {proposal.staffName}<br />{time(proposal.startAt, proposal.timezone)} – {time(proposal.endAt, proposal.timezone)} · {proposal.durationMinutes} minutes</p>
        <p>Review expires {time(proposal.expiresAt, proposal.timezone)}. If the replacement fails, your original appointment remains.</p>
        <button disabled={busy || !attempt?.confirmation && Date.parse(proposal.expiresAt) <= clock} onClick={() => { void confirm(); }}>{attempt?.confirmation ? 'Retry same rescheduling' : 'Confirm rescheduling'}</button>
      </div>}
      <button className="secondary" disabled={busy || !!attempt?.confirmation} onClick={abandon}>Keep original appointment</button>
    </>}
  </section>;
}
