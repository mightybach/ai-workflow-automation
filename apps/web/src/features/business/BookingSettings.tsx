import { useEffect, useState } from 'react';
import {
  BusinessBookingSettingsSchema, UpdateBusinessBookingSettingsSchema,
  type BusinessBookingSettings, type BusinessRole, type UpdateBusinessBookingSettings,
} from '@flowpilot/contracts';
import { ApiFailure, apiRequest, errorMessage } from '../../lib/api';

const path = '/admin/business/booking-settings';
export function BookingSettings({ role, refresh }: { role: BusinessRole; refresh: number }) {
  const [settings, setSettings] = useState<BusinessBookingSettings | null>(null);
  const [maximum, setMaximum] = useState(120);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [attempt, setAttempt] = useState<{ key: string; body: UpdateBusinessBookingSettings } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setNotice('');
    void apiRequest(path, BusinessBookingSettingsSchema, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setSettings(result); setMaximum(result.maxBookingDurationMinutes); setAttempt(null); setNeedsRefresh(false); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setSettings(null); setError(errorMessage(cause)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh, reload]);
  async function save() {
    if (!settings || role !== 'OWNER' || saving || needsRefresh) return;
    const request = attempt ?? { key: crypto.randomUUID(), body: UpdateBusinessBookingSettingsSchema.parse({
      maxBookingDurationMinutes: maximum, expectedUpdatedAt: settings.updatedAt,
    }) };
    setAttempt(request); setSaving(true); setError(''); setNotice('');
    let writeConfirmed = false;
    try {
      await apiRequest(path, BusinessBookingSettingsSchema, { method: 'PUT', body: request.body, idempotencyKey: request.key });
      writeConfirmed = true;
      setAttempt(null);
      // Replayed writes return the original snapshot. Read current state so a
      // delayed retry cannot display an older value over another owner's edit.
      const current = await apiRequest(path, BusinessBookingSettingsSchema);
      setSettings(current); setMaximum(current.maxBookingDurationMinutes);
      setNotice('Booking settings saved. Existing bookings are unchanged.');
    } catch (cause) {
      const definitive = cause instanceof ApiFailure && cause.status >= 400 && cause.status < 500;
      if (definitive || writeConfirmed) { setAttempt(null); setNeedsRefresh(true); }
      setError(writeConfirmed ? 'Your save succeeded, but the latest settings could not be loaded. Refresh settings to read the current value.' :
        errorMessage(cause) + (definitive ? ' Refresh settings before editing again.' : ' Retry the same save to check its result, or refresh settings to read the current value.'));
    } finally { setSaving(false); }
  }
  return <section aria-labelledby="booking-settings-heading" aria-busy={loading || saving}>
    <div className="section-heading"><h3 id="booking-settings-heading">Booking settings</h3>
      <button className="secondary" disabled={loading || saving} onClick={() => setReload((value) => value + 1)}>Refresh settings</button></div>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="success">{notice}</p>}
    {loading ? <p role="status">Loading booking settings…</p> : settings && <>
      <p>Current maximum appointment length: <strong>{settings.maxBookingDurationMinutes} minutes</strong></p>
      {role === 'OWNER' ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label htmlFor="booking-maximum">Maximum appointment length</label>
        <select id="booking-maximum" value={maximum} disabled={saving || !!attempt || needsRefresh} onChange={(event) => { setMaximum(Number(event.target.value)); setNotice(''); }}>
          {Array.from({ length: 48 }, (_, index) => (index + 1) * 30).map((minutes) => <option value={minutes} key={minutes}>{minutes} minutes</option>)}
        </select>
        <p className="note">Use 30-minute increments, up to 1,440 minutes. Reducing the limit affects new confirmations, including proposals already under review. Existing bookings keep their original duration.</p>
        <button disabled={saving || needsRefresh || !attempt && maximum === settings.maxBookingDurationMinutes}>{saving ? 'Saving settings…' : attempt ? 'Retry same save' : 'Save booking settings'}</button>
      </form> : <p className="note">Only a business owner can change this limit.</p>}
    </>}
  </section>;
}
