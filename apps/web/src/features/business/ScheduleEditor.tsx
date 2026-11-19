import { useEffect, useState } from 'react';
import {
  BusinessDateSchema, ScheduleResponseSchema, ScheduleChangeResponseSchema, UpdateScheduleSchema,
  type ScheduleResponse, type UpdateSchedule, type StaffListResponse,
} from '@flowpilot/contracts';
import { ApiFailure, apiRequest, errorMessage } from '../../lib/api';

const endpoint = '/admin/schedule';
const displayDate = (value: string) => value.split('-').reverse().join('-');
function localTime(value: string, zone: string) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: zone, hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset', hourCycle: 'h23' }).format(new Date(value));
}
export function ScheduleEditor({ today, staff, onSaved }: { today: string; staff: StaffListResponse['items']; onSaved(): void }) {
  const [date, setDate] = useState(displayDate(today));
  const [staffId, setStaffId] = useState('');
  const [snapshot, setSnapshot] = useState<ScheduleResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<UpdateSchedule['state'] | null>(null);
  const [attempt, setAttempt] = useState<{ key: string; body: UpdateSchedule } | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isoDate = /^\d{2}-\d{2}-\d{4}$/.test(date) ? displayDate(date) : '';
  const query = new URLSearchParams({ date: isoDate, ...(staffId ? { staffId } : {}) }).toString();
  useEffect(() => {
    setSelected([]); setReview(null); setAttempt(null); setError(''); setNotice(''); setNeedsRefresh(false);
    if (!BusinessDateSchema.safeParse(isoDate).success) { setLoading(false); setSnapshot(null); setError('Enter a valid schedule date as dd-mm-yyyy.'); return; }
    const controller = new AbortController();
    setLoading(true);
    void apiRequest(endpoint + '?' + query, ScheduleResponseSchema, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setSnapshot(result); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setSnapshot(null); setError(errorMessage(cause)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [isoDate, query, reload]);
  const locked = loading || saving || !!attempt || !!review || needsRefresh;
  const editable = snapshot?.items.filter((slot) => slot.state !== 'RESERVED' && slot.startAt > snapshot.referenceTime) ?? [];
  const selectedSlots = snapshot?.items.filter((slot) => selected.includes(slot.id)) ?? [];
  const changedCount = selectedSlots.filter((slot) => slot.state !== review).length;
  function prepare(state: UpdateSchedule['state']) {
    setError(''); setNotice('');
    if (state === 'AVAILABLE' && selectedSlots.some((slot) => !slot.staffActive)) { setError('Inactive staff cannot be reopened for booking.'); return; }
    setReview(state);
  }
  async function save() {
    if (!snapshot || !review || saving || needsRefresh) return;
    const request = attempt ?? { key: crypto.randomUUID(), body: UpdateScheduleSchema.parse({ slotIds: selected, state: review, expectedUpdatedAt: snapshot.updatedAt }) };
    setAttempt(request); setSaving(true); setError(''); setNotice('');
    let writeConfirmed = false;
    try {
      const result = await apiRequest(endpoint, ScheduleChangeResponseSchema, { method: 'PUT', idempotencyKey: request.key, body: request.body });
      writeConfirmed = true; setAttempt(null); onSaved();
      const current = await apiRequest(endpoint + '?' + query, ScheduleResponseSchema);
      setSnapshot(current); setSelected([]); setReview(null);
      setNotice(`Saved ${result.changedCount} slot changes. Existing bookings are unchanged.`);
    } catch (cause) {
      const definitive = cause instanceof ApiFailure && cause.status >= 400 && cause.status < 500;
      if (definitive || writeConfirmed) { setAttempt(null); setNeedsRefresh(true); }
      if (writeConfirmed) { setSnapshot(null); setReview(null); }
      setError(writeConfirmed ? 'Your schedule change was saved, but the current view could not be loaded. Refresh schedule.' :
        errorMessage(cause) + (definitive ? ' Refresh schedule before editing again.' : ' Retry the same schedule change to check its result.'));
    } finally { setSaving(false); }
  }
  return <section aria-labelledby="schedule-editor-heading" aria-busy={loading || saving}>
    <div className="section-heading"><h3 id="schedule-editor-heading">Breaks and closures</h3>
      <button className="secondary" disabled={loading || saving} onClick={() => setReload((value) => value + 1)}>Refresh schedule</button></div>
    <p className="note">Select existing future times to block a break or closure, or reopen blocked times. Reserved appointments stay scheduled. This editor does not create new working hours.</p>
    <label htmlFor="schedule-date">Schedule date (dd-mm-yyyy)</label>
    <input id="schedule-date" value={date} placeholder="dd-mm-yyyy" maxLength={10} disabled={locked} onChange={(event) => setDate(event.target.value)} />
    <label htmlFor="schedule-staff">Schedule staff</label>
    <select id="schedule-staff" value={staffId} disabled={locked} onChange={(event) => setStaffId(event.target.value)}>
      <option value="">All staff</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
    </select>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="success">{notice}</p>}
    {loading ? <p role="status">Loading schedule…</p> : snapshot && <>
      <p className="note">{snapshot.timezone} · {snapshot.items.length} existing slots. Past and reserved times cannot be selected.</p>
      {!snapshot.items.length ? <p>No inventory for this schedule date. Choose a seeded date or another staff filter.</p> : <>
        <div className="row-actions">
          <button className="secondary" disabled={locked} onClick={() => setSelected(editable.filter((slot) => slot.state === 'AVAILABLE').map((slot) => slot.id))}>Select available times</button>
          <button className="secondary" disabled={locked} onClick={() => setSelected(editable.filter((slot) => slot.state === 'BLOCKED' && slot.staffActive).map((slot) => slot.id))}>Select blocked times</button>
          <button className="secondary" disabled={locked || !selected.length} onClick={() => setSelected([])}>Clear selection</button>
        </div>
        <ul className="schedule-options" aria-label="Editable schedule slots">{snapshot.items.map((slot) => {
          const disabled = locked || slot.state === 'RESERVED' || slot.startAt <= snapshot.referenceTime;
          return <li key={slot.id}><label className="schedule-option"><input type="checkbox" aria-label={`Select ${slot.staffName} ${localTime(slot.startAt, snapshot.timezone)}`} checked={selected.includes(slot.id)} disabled={disabled}
            onChange={(event) => { setSelected((current) => event.target.checked ? [...current, slot.id] : current.filter((id) => id !== slot.id)); setError(''); setNotice(''); }} />
            <span><strong>{slot.staffName}</strong> · {localTime(slot.startAt, snapshot.timezone)}–{localTime(slot.endAt, snapshot.timezone)}<br />
              <span className="badge">{slot.state}</span>{!slot.staffActive && ' · Inactive staff'}</span></label></li>;
        })}</ul>
        {!review ? <div className="row-actions"><button disabled={locked || !selected.length} onClick={() => prepare('BLOCKED')}>Block selected times</button>
          <button className="secondary" disabled={locked || !selected.length} onClick={() => prepare('AVAILABLE')}>Reopen selected times</button></div> :
          <div className="schedule-review" aria-label="Review schedule change"><h4>Review schedule change</h4>
            <p>{selected.length} selected slots; {changedCount} will change to {review === 'BLOCKED' ? 'blocked' : 'available'}. Existing appointments will not be cancelled.</p>
            <div className="row-actions"><button disabled={saving || needsRefresh || !changedCount} onClick={() => { void save(); }}>{saving ? 'Saving schedule…' : attempt ? 'Retry same schedule change' : 'Apply schedule change'}</button>
              <button className="secondary" disabled={saving || !!attempt} onClick={() => { setReview(null); setError(''); }}>Cancel schedule review</button></div>
          </div>}
      </>}
    </>}
  </section>;
}
