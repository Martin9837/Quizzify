import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import {
  PageHeader, Card, Badge, Modal, Drawer, Spinner, ErrorState, EmptyState,
  TextField, TextArea, SelectField, useToast, Stat,
} from '../components/UI.jsx';
import { IconCalendar, IconPlus, IconSparkles, IconClock, IconLink, IconCheck } from '../components/Icons.jsx';
import { dateTime, time, date, relative, titleCase, dayLabel } from '../lib/format.js';

/**
 * Calendar and meetings. A week grid for orientation plus an agenda list for
 * actually reading, because a week grid alone hides detail on small screens.
 */

function startOfWeek(reference = new Date()) {
  const d = new Date(reference);
  const day = (d.getDay() + 6) % 7; // Monday-first
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function MeetingForm({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: '', type: 'meeting', startsAt: '', durationMinutes: 30, leadId: '', description: '' });
  const [pending, setPending] = useState(false);
  const slots = useApi(open ? '/meetings/slots/suggest' : null, { duration: 30, count: 5 });
  const leads = useApi(open ? '/leads' : null, { limit: 100 });

  const submit = async (event) => {
    event.preventDefault();
    setPending(true);
    try {
      await api.post('/meetings', {
        ...form,
        durationMinutes: Number(form.durationMinutes),
        startsAt: new Date(form.startsAt).toISOString(),
        leadId: form.leadId || undefined,
      });
      toast.success('Meeting scheduled and invitation queued');
      onCreated?.();
      onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule a meeting"
      size="wide"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="meeting-form" className="btn primary" disabled={pending || !form.title || !form.startsAt}>
            {pending ? <Spinner /> : null} Schedule
          </button>
        </>
      )}
    >
      <form id="meeting-form" className="col" onSubmit={submit}>
        <TextField label="Title" value={form.title} onChange={(e) => setForm((c) => ({ ...c, title: e.target.value }))} required autoFocus />
        <div className="grid grid-2">
          <SelectField
            label="Type"
            value={form.type}
            onChange={(e) => setForm((c) => ({ ...c, type: e.target.value }))}
            options={['meeting', 'demo', 'discovery', 'follow_up', 'internal'].map((v) => ({ value: v, label: titleCase(v) }))}
          />
          <SelectField
            label="Duration"
            value={form.durationMinutes}
            onChange={(e) => setForm((c) => ({ ...c, durationMinutes: e.target.value }))}
            options={[15, 30, 45, 60, 90].map((v) => ({ value: v, label: `${v} minutes` }))}
          />
          <TextField
            label="Starts at"
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => setForm((c) => ({ ...c, startsAt: e.target.value }))}
            required
          />
          <SelectField
            label="Contact"
            value={form.leadId}
            placeholder="No contact linked"
            onChange={(e) => setForm((c) => ({ ...c, leadId: e.target.value }))}
            options={(leads.data?.leads || []).map((lead) => ({ value: lead.id, label: `${lead.name}${lead.companyName ? ` — ${lead.companyName}` : ''}` }))}
          />
        </div>
        <TextArea label="Agenda" value={form.description} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))} rows={3} />

        {slots.data?.slots?.length > 0 && (
          <Card title="AI suggested times" subtitle="Free slots in your working hours">
            <div className="row wrap gap-2">
              {slots.data.slots.map((slot) => (
                <button
                  key={slot.startsAt}
                  type="button"
                  className="btn sm"
                  onClick={() => setForm((c) => ({ ...c, startsAt: slot.startsAt.slice(0, 16) }))}
                >
                  <IconSparkles size={12} /> {dayLabel(slot.startsAt)} {time(slot.startsAt)}
                </button>
              ))}
            </div>
            <span className="xs muted">{slots.data.slots[0]?.rationale}</span>
          </Card>
        )}
      </form>
    </Modal>
  );
}

export default function Calendar() {
  const toast = useToast();
  const [weekStart, setWeekStart] = useState(startOfWeek());
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState(null);

  const from = weekStart.toISOString();
  const to = new Date(weekStart.getTime() + 7 * 86400000).toISOString();
  const { data, loading, error, refetch } = useApi('/meetings', { from, to });
  // Pinned at mount: an inline `new Date()` would change the query key on every
  // render and refetch forever.
  const upcomingFrom = useMemo(() => new Date().toISOString(), []);
  const upcoming = useApi('/meetings', { from: upcomingFrom });

  const days = useMemo(() => Array.from({ length: 7 }).map((_, index) => {
    const day = new Date(weekStart.getTime() + index * 86400000);
    return {
      date: day,
      key: day.toISOString().slice(0, 10),
      meetings: (data?.meetings || []).filter((meeting) => meeting.startsAt.slice(0, 10) === day.toISOString().slice(0, 10)),
    };
  }), [weekStart, data]);

  const nextMeetings = (upcoming.data?.meetings || []).filter((m) => m.status === 'scheduled').slice(0, 8);

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle={`Week of ${date(weekStart)}`}
        actions={(
          <>
            <div className="btn-group">
              <button type="button" className="btn" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * 86400000))}>Previous</button>
              <button type="button" className="btn" onClick={() => setWeekStart(startOfWeek())}>This week</button>
              <button type="button" className="btn" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * 86400000))}>Next</button>
            </div>
            <button type="button" className="btn primary" onClick={() => setShowForm(true)}><IconPlus /> Schedule</button>
          </>
        )}
      />

      {error && <ErrorState error={error} onRetry={refetch} />}

      <Card flush>
        <div className="table-wrap">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(150px, 1fr))', minWidth: 900 }}>
            {days.map((day) => {
              const isToday = day.key === new Date().toISOString().slice(0, 10);
              return (
                <div
                  key={day.key}
                  style={{
                    borderRight: '1px solid var(--surface-border)',
                    background: isToday ? 'var(--accent-soft)' : 'transparent',
                    minHeight: 220,
                  }}
                >
                  <div className="card-body-pad" style={{ padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--surface-border)' }}>
                    <div className="col-tight" style={{ gap: 0 }}>
                      <span className="uppercase muted">{day.date.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                      <span className={isToday ? 'strong' : ''}>{day.date.getDate()}</span>
                    </div>
                  </div>
                  <div className="col-tight" style={{ padding: 'var(--space-2)', gap: 4 }}>
                    {day.meetings.map((meeting) => (
                      <button
                        key={meeting.id}
                        type="button"
                        className="card hover"
                        style={{ padding: 6, gap: 2, textAlign: 'left', borderLeft: `3px solid ${meeting.type === 'demo' ? 'var(--purple)' : 'var(--accent)'}` }}
                        onClick={() => setSelected(meeting)}
                      >
                        <span className="xs strong truncate">{meeting.title}</span>
                        <span className="xs muted">{time(meeting.startsAt)}</span>
                      </button>
                    ))}
                    {!day.meetings.length && <span className="xs muted center">--</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="Upcoming meetings">
          {loading && !data && <Spinner />}
          {!nextMeetings.length ? (
            <EmptyState icon={<IconCalendar size={18} />} title="Nothing scheduled" message="Book a demo or discovery call to get started." />
          ) : (
            <div className="col-tight">
              {nextMeetings.map((meeting) => (
                <button
                  key={meeting.id}
                  type="button"
                  className="between"
                  style={{ background: 'transparent', border: 0, padding: 'var(--space-2) 0', textAlign: 'left', borderBottom: '1px solid var(--surface-border)' }}
                  onClick={() => setSelected(meeting)}
                >
                  <div className="col-tight" style={{ gap: 1, minWidth: 0 }}>
                    <span className="small strong truncate">{meeting.title}</span>
                    <span className="xs muted truncate">
                      {meeting.contactName ? `${meeting.contactName}${meeting.companyName ? ` · ${meeting.companyName}` : ''}` : titleCase(meeting.type)}
                    </span>
                  </div>
                  <div className="col-tight" style={{ gap: 1, alignItems: 'flex-end' }}>
                    <span className="xs strong nowrap">{dayLabel(meeting.startsAt)} {time(meeting.startsAt)}</span>
                    {meeting.aiSuggested && <Badge tone="accent"><IconSparkles size={10} /> AI slot</Badge>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title="This week">
          <div className="grid grid-2">
            <Stat label="Meetings" value={(data?.meetings || []).length} icon={<IconCalendar />} />
            <Stat label="Demos" value={(data?.meetings || []).filter((m) => m.type === 'demo').length} icon={<IconClock />} />
          </div>
          <span className="small secondary">
            Meeting invitations are sent through the connected email provider and logged on the
            contact&apos;s timeline. Reminders fire {(data?.meetings || [])[0]?.reminderMinutes || 15} minutes before.
          </span>
        </Card>
      </div>

      <MeetingForm open={showForm} onClose={() => setShowForm(false)} onCreated={refetch} />

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.title || 'Meeting'}>
        {selected && (
          <div className="col">
            <div className="row-tight wrap">
              <Badge tone="outline">{titleCase(selected.type)}</Badge>
              <Badge tone={selected.status === 'held' ? 'success' : selected.status === 'no_show' ? 'danger' : 'outline'}>
                {titleCase(selected.status)}
              </Badge>
              {selected.aiSuggested && <Badge tone="accent">AI suggested</Badge>}
            </div>
            <Card title="When">
              <span className="small">{dateTime(selected.startsAt)} — {time(selected.endsAt)} ({selected.timezone})</span>
              <span className="xs muted">{relative(selected.startsAt)}</span>
            </Card>
            {selected.description && (
              <Card title="Agenda"><p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{selected.description}</p></Card>
            )}
            {selected.conferenceUrl && (
              <a href={selected.conferenceUrl} className="btn" target="_blank" rel="noreferrer">
                <IconLink /> Join meeting
              </a>
            )}
            {selected.attendees?.length > 0 && (
              <Card title="Attendees">
                <div className="col-tight">
                  {selected.attendees.map((attendee, index) => (
                    <span key={index} className="small">{attendee.name || attendee.email} <span className="muted">{attendee.role || ''}</span></span>
                  ))}
                </div>
              </Card>
            )}
            {selected.leadId && <Link to={`/leads/${selected.leadId}`} className="btn">Open CRM record</Link>}
            {selected.status === 'scheduled' && new Date(selected.startsAt) < new Date() && (
              <div className="row-tight">
                <button
                  type="button"
                  className="btn success grow"
                  onClick={async () => {
                    await api.patch(`/meetings/${selected.id}`, { status: 'held' });
                    toast.success('Marked as held');
                    setSelected(null);
                    refetch();
                  }}
                >
                  <IconCheck /> Mark held
                </button>
                <button
                  type="button"
                  className="btn grow"
                  onClick={async () => {
                    await api.patch(`/meetings/${selected.id}`, { status: 'no_show' });
                    toast.info('Marked as no-show');
                    setSelected(null);
                    refetch();
                  }}
                >
                  No show
                </button>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
