import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { useRealtimeEvent } from '../lib/realtime.jsx';
import { PageHeader, Card, Badge, Spinner, ErrorState, EmptyState, Tabs } from '../components/UI.jsx';
import {
  IconPhone, IconMail, IconCalendar, IconNote, IconTask, IconEdit,
  IconSparkles, IconWave, IconMessage, IconCheck,
} from '../components/Icons.jsx';
import { relative, dateTime, titleCase, duration, percent } from '../lib/format.js';

/**
 * Communication hub: one chronological feed across every channel, with the
 * actor (human or AI) visible on each entry. Filters map to the channels a sales
 * team actually reviews.
 */

const ICONS = {
  call: <IconPhone size={13} />,
  email: <IconMail size={13} />,
  meeting: <IconCalendar size={13} />,
  note: <IconNote size={13} />,
  task: <IconTask size={13} />,
  crm_change: <IconEdit size={13} />,
  ai_insight: <IconSparkles size={13} />,
  stage_change: <IconWave size={13} />,
  lead_created: <IconCheck size={13} />,
  sms: <IconMessage size={13} />,
  whatsapp: <IconMessage size={13} />,
  assignment: <IconCheck size={13} />,
};

const FILTERS = [
  { key: 'all', label: 'Everything', types: undefined },
  { key: 'calls', label: 'Calls', types: 'call' },
  { key: 'emails', label: 'Emails', types: 'email' },
  { key: 'messages', label: 'Messages', types: 'sms,whatsapp' },
  { key: 'meetings', label: 'Meetings', types: 'meeting' },
  { key: 'notes', label: 'Notes', types: 'note' },
  { key: 'tasks', label: 'Tasks', types: 'task' },
  { key: 'crm', label: 'CRM changes', types: 'crm_change,stage_change' },
  { key: 'ai', label: 'AI activity', types: 'ai_insight' },
];

export default function Activity() {
  const [filter, setFilter] = useState('all');
  const [actorType, setActorType] = useState('');
  const active = FILTERS.find((entry) => entry.key === filter);

  const { data, loading, error, refetch } = useApi('/activities', {
    limit: 120,
    types: active?.types,
    actorType: actorType || undefined,
  });

  useRealtimeEvent('activity.created', () => refetch());

  const activities = data?.activities || [];

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Every call, email, message, meeting, note and CRM change in one feed"
        actions={(
          <div className="pill-tabs">
            {['', 'user', 'ai'].map((value) => (
              <button key={value || 'all'} type="button" className={actorType === value ? 'active' : ''} onClick={() => setActorType(value)}>
                {value === '' ? 'All actors' : value === 'ai' ? 'AI only' : 'People only'}
              </button>
            ))}
          </div>
        )}
      />

      <Card flush>
        <div className="card-body-pad" style={{ paddingBottom: 0, overflowX: 'auto' }}>
          <Tabs active={filter} onChange={setFilter} tabs={FILTERS} />
        </div>

        <div className="card-body-pad">
          {loading && !data && <Spinner label="Loading activity" />}
          {error && <ErrorState error={error} onRetry={refetch} />}
          {!loading && !activities.length && (
            <EmptyState icon={<IconWave size={20} />} title="No activity" message="Nothing matches this filter yet." />
          )}

          <div className="timeline">
            {activities.map((item) => (
              <div key={item.id} className="timeline-item">
                <span className={`timeline-dot ${item.actorType === 'ai' ? 'ai' : item.type}`}>
                  {ICONS[item.type] || <IconWave size={13} />}
                </span>
                <div className="timeline-content col-tight" style={{ gap: 2 }}>
                  <div className="row-tight wrap">
                    <span className="small strong">{item.title}</span>
                    {item.actorType === 'ai' && <Badge tone="accent"><IconSparkles size={10} /> AI</Badge>}
                    {item.actorType === 'automation' && <Badge tone="purple">automation</Badge>}
                    {item.contactName && item.leadId && (
                      <Link to={`/leads/${item.leadId}`} className="small">{item.contactName}</Link>
                    )}
                    {item.companyName && <span className="xs muted">{item.companyName}</span>}
                  </div>
                  {item.body && <p className="small secondary" style={{ margin: 0 }}>{item.body}</p>}
                  <span className="xs muted row-tight wrap">
                    <span title={dateTime(item.occurredAt)}>{relative(item.occurredAt)}</span>
                    {item.actorName && <span>· {item.actorName}</span>}
                    {item.type === 'call' && item.metadata?.durationSeconds !== undefined && (
                      <span>· {duration(item.metadata.durationSeconds)}</span>
                    )}
                    {item.type === 'crm_change' && item.metadata?.field && (
                      <span>
                        · {titleCase(item.metadata.field)}: {String(item.metadata.from ?? 'not set')} → {String(item.metadata.to)}
                        {item.metadata.confidence ? ` (${percent(item.metadata.confidence * 100)} confidence)` : ''}
                      </span>
                    )}
                    {item.type === 'ai_insight' && item.metadata?.score !== null && item.metadata?.score !== undefined && (
                      <span>· score {item.metadata.score}</span>
                    )}
                    {item.type === 'call' && item.refId && (
                      <>· <Link to={`/conversations/${item.refId}`}>open conversation</Link></>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}
