import { useEffect, useState } from 'react';
import { BusinessDateSchema, AddWorkingTimeSchema, CreateClosureSchema, ReleaseClosureSchema, SchedulePolicyResponseSchema, SchedulePolicyChangeSchema,
  type SchedulePolicyResponse, type StaffListResponse } from '@flowpilot/contracts';
import { ApiFailure, apiRequest, errorMessage } from '../../lib/api';

type Review = { kind: 'hours' | 'close' | 'release'; body: Record<string, unknown> };
const displayDate = (value: string) => value.split('-').reverse().join('-');
const time = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export function SchedulePolicyEditor({ today, staff, onSaved }: { today: string; staff: StaffListResponse['items']; onSaved(): void }) {
  const [date, setDate] = useState(displayDate(today)); const [staffId, setStaffId] = useState('');
  const [kind, setKind] = useState<'hours' | 'close'>('hours'); const [startMinute, setStartMinute] = useState(540); const [endMinute, setEndMinute] = useState(1020);
  const [snapshot, setSnapshot] = useState<SchedulePolicyResponse | null>(null); const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [needsRefresh, setNeedsRefresh] = useState(false);
  const [review, setReview] = useState<Review | null>(null); const [attempt, setAttempt] = useState<(Review & { key: string }) | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const isoDate = /^\d{2}-\d{2}-\d{4}$/.test(date) ? displayDate(date) : '';
  const query = new URLSearchParams({ date: isoDate, ...(staffId ? { staffId } : {}) }).toString();
  useEffect(() => {
    setReview(null); setAttempt(null); setNeedsRefresh(false); setError(''); setNotice('');
    if (!BusinessDateSchema.safeParse(isoDate).success) { setSnapshot(null); setLoading(false); setError('Enter a valid policy date as dd-mm-yyyy.'); return; }
    const controller = new AbortController(); setLoading(true);
    void apiRequest('/admin/schedule/policies?' + query, SchedulePolicyResponseSchema, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setSnapshot(result); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setSnapshot(null); setError(errorMessage(cause)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [isoDate, query, reload]);
  const locked = loading || saving || !!review || !!attempt || needsRefresh;
  function prepare() {
    if (!snapshot) return;
    const value = { date: isoDate, staffId: staffId || null, startMinute, endMinute, expectedUpdatedAt: snapshot.updatedAt };
    const parsed = kind === 'hours' ? AddWorkingTimeSchema.safeParse(value) : CreateClosureSchema.safeParse(value);
    if (!parsed.success) { setError('Choose staff for working hours and an end time after the start, in 30-minute steps.'); return; }
    setError(''); setNotice(''); setReview({ kind, body: parsed.data });
  }
  async function save() {
    if (!review || saving || needsRefresh) return;
    const request = attempt ?? { ...review, key: crypto.randomUUID() }; setAttempt(request); setSaving(true); setError(''); setNotice('');
    let confirmed = false;
    try {
      const change = await apiRequest('/admin/schedule/' + request.kind, SchedulePolicyChangeSchema, { method: 'PUT', idempotencyKey: request.key, body: request.body });
      confirmed = true; setAttempt(null); onSaved();
      const current = await apiRequest('/admin/schedule/policies?' + query, SchedulePolicyResponseSchema);
      setSnapshot(current); setReview(null);
      setNotice(request.kind === 'release' ? 'Closure lifted. Slots stay blocked; refresh Breaks and closures to reopen them explicitly.' : `Saved. ${change.createdCount} slots added; ${change.blockedCount} blocked by this operation. Refresh Breaks and closures to inspect the inventory.`);
    } catch (cause) {
      const definitive = cause instanceof ApiFailure && cause.status >= 400 && cause.status < 500;
      if (definitive || confirmed) { setAttempt(null); setNeedsRefresh(true); }
      setError(confirmed ? 'The change was saved, but the current policies could not be loaded. Refresh policies.' : errorMessage(cause) + (definitive ? ' Refresh policies before editing again.' : ' Retry the same policy change to check its result.'));
    } finally { setSaving(false); }
  }
  const label = (instant: string) => new Intl.DateTimeFormat('en-AU', { timeZone: snapshot?.timezone ?? 'Australia/Brisbane', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset', hourCycle: 'h23' }).format(new Date(instant));
  return <section aria-labelledby="schedule-policy-heading" aria-busy={loading || saving}>
    <div className="section-heading"><h3 id="schedule-policy-heading">Working hours and closure rules</h3><button className="secondary" disabled={loading || saving} onClick={() => setReload((value) => value + 1)}>Refresh policies</button></div>
    <p className="note">Add working time for a future date, or create a closure that also protects inventory added later. Existing slots keep their current state. Closures cannot overlap reserved appointments.</p>
    <label htmlFor="policy-date">Policy date (dd-mm-yyyy)</label><input id="policy-date" value={date} disabled={locked} maxLength={10} placeholder="dd-mm-yyyy" onChange={(event) => setDate(event.target.value)} />
    <label htmlFor="policy-kind">Schedule operation</label><select id="policy-kind" disabled={locked} value={kind} onChange={(event) => setKind(event.target.value as 'hours' | 'close')}><option value="hours">Add working time</option><option value="close">Create closure</option></select>
    <label htmlFor="policy-staff">Policy staff</label><select id="policy-staff" disabled={locked} value={staffId} onChange={(event) => setStaffId(event.target.value)}><option value="">{kind === 'close' ? 'Entire business' : 'Choose a staff member'}</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select>
    <div className="booking-fields"><div><label htmlFor="policy-start">Window starts</label><select id="policy-start" value={startMinute} disabled={locked} onChange={(event) => setStartMinute(Number(event.target.value))}>{Array.from({ length: 48 }, (_, i) => i * 30).map((minutes) => <option key={minutes} value={minutes}>{time(minutes)}</option>)}</select></div>
      <div><label htmlFor="policy-end">Window ends</label><select id="policy-end" value={endMinute} disabled={locked} onChange={(event) => setEndMinute(Number(event.target.value))}>{Array.from({ length: 48 }, (_, i) => (i + 1) * 30).map((minutes) => <option key={minutes} value={minutes}>{time(minutes)}</option>)}</select></div></div>
    {snapshot && <p className="note">Times use {snapshot.timezone}. 24:00 is the end of this local date. Ambiguous or missing DST boundaries require another time.</p>}
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="success">{notice}</p>}
    {loading ? <p role="status">Loading closure policies…</p> : snapshot && <>
      <button disabled={locked} onClick={prepare}>{kind === 'hours' ? 'Review working time' : 'Review closure'}</button>
      {review && <div className="schedule-review"><h4>Review schedule policy</h4><p>{review.kind === 'release' ? 'Lift this closure without reopening slots. Other overlapping closures still apply.' : `${date}, ${time(startMinute)}–${time(endMinute)}, ${staff.find((person) => person.id === staffId)?.displayName ?? 'entire business'}. ${review.kind === 'hours' ? 'Only missing slots are added; active closures keep new slots blocked.' : 'Available times become blocked; any reserved conflict rejects the whole closure.'}`}</p>
        <div className="row-actions"><button disabled={saving || needsRefresh} onClick={() => { void save(); }}>{saving ? 'Saving policy…' : attempt ? 'Retry same policy change' : 'Apply schedule policy'}</button><button className="secondary" disabled={saving || !!attempt} onClick={() => setReview(null)}>Cancel policy review</button></div></div>}
      <h4>Active closures on this date</h4>{!snapshot.closures.length ? <p>No active closure rules for this view.</p> : <ul className="setup-list">{snapshot.closures.map((closure) => <li key={closure.id}><div><strong>{closure.staffId ? staff.find((person) => person.id === closure.staffId)?.displayName ?? 'Staff closure' : 'Entire business'}</strong><br />{label(closure.startAt)} – {label(closure.endAt)}<br />
        <button className="secondary" disabled={locked} onClick={() => { setReview({ kind: 'release', body: ReleaseClosureSchema.parse({ closureId: closure.id, expectedUpdatedAt: snapshot.updatedAt }) }); setNotice(''); setError(''); }}>Review lift closure</button></div></li>)}</ul>}
    </>}
  </section>;
}
