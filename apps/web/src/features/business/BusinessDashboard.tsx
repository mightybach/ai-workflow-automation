import { lazy, Suspense, useEffect, useState } from 'react';
import {
  AdminSlotListResponseSchema, BusinessDateSchema, BusinessSetupResponseSchema,
  ServiceListResponseSchema, StaffListResponseSchema, SlotStateSchema,
  type AdminSlotListResponse, type BusinessSetupResponse, type ServiceListResponse, type StaffListResponse,
} from '@flowpilot/contracts';
import { apiRequest, errorMessage } from '../../lib/api';
import { BookingSettings } from './BookingSettings';
const ScheduleEditor = lazy(() => import('./ScheduleEditor').then((module) => ({ default: module.ScheduleEditor })));
const SchedulePolicyEditor = lazy(() => import('./SchedulePolicyEditor').then((module) => ({ default: module.SchedulePolicyEditor })));
const BookingAdministration = lazy(() => import('./BookingAdministration').then((module) => ({ default: module.BookingAdministration })));
const BusinessWorkflows = lazy(() => import('./BusinessWorkflows').then((module) => ({ default: module.BusinessWorkflows })));

const displayDate = (iso: string) => iso.split('-').reverse().join('-');
const apiDate = (display: string) => /^\d{2}-\d{2}-\d{4}$/.test(display) ? displayDate(display) : '';

function Pages({ name, page, total, size, disabled, onPage }: {
  name: string; page: number; total: number; size: number; disabled: boolean; onPage(page: number): void;
}) {
  return <nav className="pagination" aria-label={name + ' pages'}>
    <button className="secondary" disabled={disabled || page <= 1} aria-label={'Previous ' + name + ' page'} onClick={() => onPage(page - 1)}>Previous</button>
    <span>Page {page} of {Math.max(1, Math.ceil(total / size))} · {total} {name}</span>
    <button className="secondary" disabled={disabled || page * size >= total} aria-label={'Next ' + name + ' page'} onClick={() => onPage(page + 1)}>Next</button>
  </nav>;
}
export function BusinessDashboard({ actorId }: { actorId: string }) {
  const [setup, setSetup] = useState<BusinessSetupResponse | null>(null);
  const [staff, setStaff] = useState<StaffListResponse | null>(null);
  const [services, setServices] = useState<ServiceListResponse | null>(null);
  const [slots, setSlots] = useState<AdminSlotListResponse | null>(null);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [slotError, setSlotError] = useState('');
  const [loading, setLoading] = useState(true);
  const [listsLoading, setListsLoading] = useState(true);
  const [slotsLoading, setSlotsLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [date, setDate] = useState('');
  const [staffId, setStaffId] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [staffPage, setStaffPage] = useState(1);
  const [servicePage, setServicePage] = useState(1);
  const [inventoryRefresh, setInventoryRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void apiRequest('/admin/business', BusinessSetupResponseSchema, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) { setSetup(value); setDate((current) => current || displayDate(value.today)); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setSetup(null); setError(errorMessage(cause)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!setup) return;
    const controller = new AbortController();
    setListsLoading(true); setListError('');
    void Promise.all([
      apiRequest('/admin/staff?page=' + staffPage + '&pageSize=50', StaffListResponseSchema, { signal: controller.signal }),
      apiRequest('/admin/services?page=' + servicePage + '&pageSize=50', ServiceListResponseSchema, { signal: controller.signal }),
    ]).then(([people, offerings]) => {
      if (!controller.signal.aborted) { setStaff(people); setServices(offerings); }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) { setStaff(null); setServices(null); setListError(errorMessage(cause)); }
    }).finally(() => { if (!controller.signal.aborted) setListsLoading(false); });
    return () => controller.abort();
  }, [setup, staffPage, servicePage, refresh]);

  useEffect(() => {
    if (!setup) return;
    const parsed = BusinessDateSchema.safeParse(apiDate(date));
    if (!parsed.success) { setSlots(null); setSlotError('Enter a valid date as dd-mm-yyyy.'); setSlotsLoading(false); return; }
    const controller = new AbortController();
    setSlotsLoading(true); setSlotError('');
    const query = new URLSearchParams({ date: parsed.data, page: String(page), pageSize: '20' });
    if (staffId) query.set('staffId', staffId);
    if (state) query.set('state', state);
    void apiRequest('/admin/slots?' + query, AdminSlotListResponseSchema, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setSlots(value); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setSlots(null); setSlotError(errorMessage(cause)); } })
      .finally(() => { if (!controller.signal.aborted) setSlotsLoading(false); });
    return () => controller.abort();
  }, [setup, date, staffId, state, page, refresh, inventoryRefresh]);

  return <div>
    <div className="section-heading">
      <h2>Business dashboard</h2>
      <button className="secondary" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh setup</button>
    </div>
    {loading ? <p role="status">Loading business setup…</p> : error ? <p role="alert" className="error">{error}</p> : setup && <>
      <section aria-labelledby="business-name">
        <span className="badge">Synthetic salon · {setup.membership.role}</span>
        <h2 id="business-name">{setup.business.name}</h2>
        <p>Time zone: <strong>{setup.business.timezone}</strong></p>
        <p className="note">Inspect staff, services and slot inventory. Business owners can edit booking settings and block or reopen future times.</p>
      </section>
      <BookingSettings role={setup.membership.role} refresh={refresh} />
      <Suspense fallback={<p role="status">Loading workflows…</p>}><BusinessWorkflows key={setup.business.id + actorId} actorId={actorId} businessId={setup.business.id} role={setup.membership.role} today={setup.today} /></Suspense>
      {staff && <Suspense fallback={<p role="status">Loading booking administration…</p>}><BookingAdministration businessId={setup.business.id} actorId={actorId} role={setup.membership.role} today={setup.today} timezone={setup.business.timezone} staff={staff.items} onSaved={() => setInventoryRefresh((n) => n + 1)} /></Suspense>}
      {listError && <p role="alert" className="error">{listError}</p>}
      {listsLoading ? <p role="status">Loading staff and services…</p> : <div className="setup-grid">
        <section aria-labelledby="staff-heading">
          <h3 id="staff-heading">Staff</h3>
          {staff && <>
            {staff.items.length === 0 ? <p>No staff configured.</p> : <ul className="setup-list">{staff.items.map((person) =>
              <li key={person.id}><strong>{person.displayName}</strong><span className="badge">{person.active ? 'Active' : 'Inactive'}</span></li>)}</ul>}
            {staff.pagination.total > 50 && <Pages name="staff" page={staffPage} total={staff.pagination.total} size={50} disabled={listsLoading} onPage={setStaffPage} />}
          </>}
        </section>
        <section aria-labelledby="services-heading">
          <h3 id="services-heading">Services</h3>
          {services && <>
            {services.items.length === 0 ? <p>No services configured.</p> : <ul className="setup-list">{services.items.map((service) =>
              <li key={service.id}><strong>{service.name}</strong><span>{service.durationMinutes} minutes · {service.active ? 'Active' : 'Inactive'}</span></li>)}</ul>}
            {services.pagination.total > 50 && <Pages name="services" page={servicePage} total={services.pagination.total} size={50} disabled={listsLoading} onPage={setServicePage} />}
          </>}
        </section>
      </div>}
      {setup.membership.role === 'OWNER' && <>
        <Suspense fallback={<p role="status">Loading working hours editor…</p>}><SchedulePolicyEditor today={setup.today} staff={staff?.items ?? []} onSaved={() => setInventoryRefresh((value) => value + 1)} /></Suspense>
        <Suspense fallback={<p role="status">Loading inventory editor…</p>}><ScheduleEditor today={setup.today} staff={staff?.items ?? []} onSaved={() => setInventoryRefresh((value) => value + 1)} /></Suspense>
      </>}
      <section aria-labelledby="slot-heading" aria-busy={slotsLoading}>
        <h3 id="slot-heading">Slot inventory</h3>
        <p className="note">Times below use {setup.business.timezone}. This inventory view is not a booking guarantee.</p>
        <div className="toolbar">
          <label htmlFor="slot-date">Date</label>
          <input id="slot-date" type="text" inputMode="numeric" placeholder="dd-mm-yyyy" aria-describedby="slot-date-format" maxLength={10} value={date} onChange={(event) => { setDate(event.target.value); setPage(1); }} />
          <span id="slot-date-format" className="note">dd-mm-yyyy</span>
          <label htmlFor="slot-staff">Staff member</label>
          <select id="slot-staff" value={staffId} onChange={(event) => { setStaffId(event.target.value); setPage(1); }}>
            <option value="">All staff</option>
            {staff?.items.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
          <label htmlFor="slot-state">Inventory state</label>
          <select id="slot-state" value={state} onChange={(event) => { setState(event.target.value); setPage(1); }}>
            <option value="">All states</option>{SlotStateSchema.options.map((value) => <option key={value}>{value}</option>)}
          </select>
        </div>
        {slotError && <p role="alert" className="error">{slotError}</p>}
        {slotsLoading ? <p role="status">Loading slot inventory…</p> : !slotError && slots && <>
          {slots.items.length === 0 ? <p>No slots for this date and filter.</p> : <div className="table-scroll">
            <table className="slot-table"><caption className="sr-only">Staff slot inventory</caption>
              <thead><tr><th scope="col">Staff</th><th scope="col">Local time</th><th scope="col">State</th></tr></thead>
              <tbody>{slots.items.map((slot) => {
                const format = (value: string) => new Intl.DateTimeFormat('en-AU', { timeZone: setup.business.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(value));
                return <tr key={slot.id}><td>{staff?.items.find((person) => person.id === slot.staffId)?.displayName ?? slot.staffId}</td>
                  <td>{format(slot.startAt)} – {format(slot.endAt)}</td><td><span className="badge">{slot.state}</span></td></tr>;
              })}</tbody>
            </table>
          </div>}
          <Pages name="slots" page={page} total={slots.pagination.total} size={20} disabled={slotsLoading} onPage={setPage} />
        </>}
      </section>
    </>}
  </div>;
}

