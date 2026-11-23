import { useEffect, useState } from 'react';
import { AdminBookingListSchema, BusinessTaskListSchema, type BusinessTask } from '@flowpilot/contracts';
import { apiRequest, errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';

const dayLabel = (date: string) => date.split('-').reverse().join('-');
export function DashboardOverview({ date, today, timezone, teamTotal, serviceTotal, refresh, onDate }: {
  date: string; today: string; timezone: string; teamTotal: number | null; serviceTotal: number | null; refresh: number; onDate(date: string): void;
}) {
  const [appointments, setAppointments] = useState<number | null>(null); const [taskTotal, setTaskTotal] = useState<number | null>(null);
  const [tasks, setTasks] = useState<BusinessTask[]>([]); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const [month, setMonth] = useState(date.slice(0, 7));
  useEffect(() => { setMonth(date.slice(0, 7)); }, [date]);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setAppointments(null); setTaskTotal(null); setTasks([]);
    void Promise.all([
      apiRequest('/admin/bookings?' + new URLSearchParams({ date, status: 'CONFIRMED', pageSize: '1' }), AdminBookingListSchema, { signal: controller.signal }),
      apiRequest('/admin/tasks?status=OPEN&pageSize=3', BusinessTaskListSchema, { signal: controller.signal }),
    ]).then(([bookings, work]) => { if (!controller.signal.aborted) { setAppointments(bookings.pagination.total); setTaskTotal(work.pagination.total); setTasks(work.items); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [date, refresh, retry]);
  const year = Number(month.slice(0, 4)); const index = Number(month.slice(5)) - 1;
  const first = (new Date(Date.UTC(year, index, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  const monthLabel = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, index, 1)));
  function changeMonth(delta: number) { const next = new Date(Date.UTC(year, index + delta, 1)).toISOString().slice(0, 7); if (next >= '2000-01' && next <= '2100-12') setMonth(next); }
  return <div className="dashboard-overview" id="overview">
    <div className="overview-main">
      <div className="overview-intro"><div><p className="eyebrow">YOUR WORKSPACE, AT A GLANCE</p><h3>A little more organised.</h3><p>Make room for a smoother day.</p></div><span className="live-label"><i />Business data</span></div>
      <div className="metric-grid" aria-label="Business overview">
        <a className="metric-card" href="#appointments"><span className="metric-top">Appointments<Icon name="calendar" /></span><strong>{appointments ?? '—'}</strong><span>Confirmed · {dayLabel(date)}</span></a>
        <a className="metric-card" href="#team"><span className="metric-top">Team members<Icon name="team" /></span><strong>{teamTotal ?? '—'}</strong><span>Your business team</span></a>
        <a className="metric-card" href="#workflows"><span className="metric-top">Open tasks<Icon name="check" /></span><strong>{taskTotal ?? '—'}</strong><span>Across all appointment dates</span></a>
        <a className="metric-card metric-accent" href="/book"><span className="metric-top">A moment for you<Icon name="spark" /></span><strong className="metric-callout">Book something good.</strong><span className="pill-link">Open booking page <Icon name="arrow" size={15} /></span></a>
      </div>
      <div className="overview-bottom"><span><strong>{serviceTotal ?? '—'}</strong> configured services</span><a href="#services">Explore services <Icon name="arrow" size={15} /></a></div>
      {error && <div role="alert" className="error">Overview unavailable. {error}<button className="secondary" onClick={() => setRetry((n) => n + 1)}>Retry overview</button></div>}
    </div>
    <aside className="day-planner" aria-label="Day planner">
      <div className="section-heading"><h3>Calendar</h3><span className="note">{timezone.split('/').at(-1)?.replaceAll('_', ' ')}</span></div>
      <div className="calendar-month"><span>{monthLabel}</span><div><button className="icon-button" aria-label="Previous calendar month" disabled={month <= '2000-01'} onClick={() => changeMonth(-1)}><Icon name="chevron-left" size={15} /></button><button className="icon-button" aria-label="Next calendar month" disabled={month >= '2100-12'} onClick={() => changeMonth(1)}><Icon name="chevron-right" size={15} /></button></div></div>
      <div className="mini-calendar"><div className="calendar-weekdays">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, n) => <span key={n}>{day}</span>)}</div><div className="calendar-days">
        {Array.from({ length: first }, (_, n) => <span key={'blank' + n} />)}
        {Array.from({ length: count }, (_, n) => { const value = `${month}-${String(n + 1).padStart(2, '0')}`; return <button key={value} className={(value === date ? 'selected ' : '') + (value === today ? 'calendar-today' : '')} aria-label={`View inventory ${dayLabel(value)}`} aria-pressed={value === date} aria-current={value === today ? 'date' : undefined} onClick={() => onDate(value)}>{n + 1}</button>; })}
      </div></div>
      <div className="section-heading planner-heading"><h3>On your list</h3><a href="#workflows">View tasks</a></div>
      {taskTotal === 0 ? <p className="planner-empty">All clear for now.<br />New workflow tasks will appear here.</p> : <ul className="planner-tasks">{tasks.map((task) => <li key={task.id}><span className="task-marker" aria-hidden="true" /><div><a href="#workflows">{task.kind === 'PREPARE_APPOINTMENT' ? 'Prepare appointment' : 'Review arrival enquiry'}</a><span>{task.serviceName} · {task.staffName}</span><small>{new Intl.DateTimeFormat('en-GB', { timeZone: task.timezone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(task.dueAt)).replaceAll('/', '-')}</small></div></li>)}</ul>}
      <p className="planner-footnote">The calendar filters inventory. It doesn’t reserve a time.</p>
    </aside>
  </div>;
}
