import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader, Card, Badge, Stat, Tabs, Spinner, ErrorState, EmptyState, useToast, Avatar,
} from '../components/UI.jsx';
import { NewTaskModal } from './LeadDetail.jsx';
import { IconTask, IconPlus, IconCheck, IconSparkles, IconAlert, IconClock, IconPhone } from '../components/Icons.jsx';
import { relative, dateTime, titleCase, number } from '../lib/format.js';

/** Task list with the filters an agent actually uses: today, overdue, AI-created. */
export default function Tasks() {
  const toast = useToast();
  const { isManager } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState('open');
  const [showNew, setShowNew] = useState(searchParams.get('new') === '1');

  const query = {
    limit: 150,
    status: tab === 'done' ? 'done' : undefined,
    overdue: tab === 'overdue' ? 'true' : undefined,
    today: tab === 'today' ? 'true' : undefined,
    source: tab === 'ai' ? 'ai' : undefined,
  };
  const { data, loading, error, refetch } = useApi('/tasks', query);

  const complete = async (task) => {
    await api.post(`/tasks/${task.id}/complete`);
    toast.success('Task completed');
    refetch();
  };

  const tasks = data?.tasks || [];
  const grouped = tasks.reduce((acc, task) => {
    const key = !task.dueAt ? 'No due date'
      : new Date(task.dueAt) < new Date(new Date().setHours(0, 0, 0, 0)) ? 'Overdue'
        : new Date(task.dueAt) <= new Date(new Date().setHours(23, 59, 59, 999)) ? 'Today'
          : new Date(task.dueAt) <= new Date(Date.now() + 7 * 86400000) ? 'This week' : 'Later';
    acc[key] = acc[key] || [];
    acc[key].push(task);
    return acc;
  }, {});
  const order = ['Overdue', 'Today', 'This week', 'Later', 'No due date'];

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={data ? `${number(data.total)} tasks · ${data.counts.overdue} overdue` : 'Loading'}
        actions={<button type="button" className="btn primary" onClick={() => setShowNew(true)}><IconPlus /> New task</button>}
      />

      <div className="grid grid-4">
        <Stat label="Open" value={number(tasks.filter((t) => t.status === 'open').length)} icon={<IconTask />} />
        <Stat label="Due today" value={number(data?.counts?.today || 0)} icon={<IconClock />} />
        <Stat label="Overdue" value={number(data?.counts?.overdue || 0)} accent={data?.counts?.overdue ? 'var(--danger)' : undefined} icon={<IconAlert />} />
        <Stat label="Created by AI" value={number(tasks.filter((t) => t.source === 'ai').length)} icon={<IconSparkles />} />
      </div>

      <Card flush>
        <div className="card-body-pad" style={{ paddingBottom: 0 }}>
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'open', label: 'Open' },
              { key: 'today', label: 'Today' },
              { key: 'overdue', label: 'Overdue' },
              { key: 'ai', label: 'AI created' },
              { key: 'done', label: 'Completed' },
            ]}
          />
        </div>

        <div className="card-body-pad">
          {loading && !data && <Spinner label="Loading tasks" />}
          {error && <ErrorState error={error} onRetry={refetch} />}
          {!loading && !tasks.length && (
            <EmptyState icon={<IconCheck size={20} />} title="Nothing here" message="No tasks match this filter." />
          )}

          <div className="col">
            {order.filter((group) => grouped[group]?.length).map((group) => (
              <div key={group} className="col-tight">
                <div className="row-tight">
                  <span className="uppercase muted">{group}</span>
                  <Badge tone={group === 'Overdue' ? 'danger' : 'outline'}>{grouped[group].length}</Badge>
                </div>
                {grouped[group].map((task) => (
                  <div key={task.id} className="row gap-2" style={{ alignItems: 'flex-start', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--surface-border)' }}>
                    <button
                      type="button"
                      className="btn ghost icon sm"
                      aria-label={`Complete ${task.title}`}
                      disabled={task.status !== 'open' && task.status !== 'in_progress'}
                      onClick={() => complete(task)}
                    >
                      <IconCheck size={14} />
                    </button>
                    <div className="grow col-tight" style={{ gap: 2, minWidth: 0 }}>
                      <span className={`small ${task.status === 'done' ? 'muted' : 'strong'}`} style={task.status === 'done' ? { textDecoration: 'line-through' } : undefined}>
                        {task.title}
                      </span>
                      <span className="xs muted row-tight wrap">
                        <Badge tone={task.priority === 'urgent' ? 'danger' : task.priority === 'high' ? 'warning' : 'outline'}>{task.priority}</Badge>
                        <Badge tone="outline">{titleCase(task.type)}</Badge>
                        {task.source === 'ai' && <Badge tone="accent"><IconSparkles size={10} /> AI</Badge>}
                        <span title={dateTime(task.dueAt)}>{task.dueAt ? relative(task.dueAt) : 'no due date'}</span>
                        {task.contactName && task.leadId && (
                          <Link to={`/leads/${task.leadId}`}>{task.contactName}{task.companyName ? ` · ${task.companyName}` : ''}</Link>
                        )}
                        {isManager && task.assigneeName && <span className="row-tight"><Avatar name={task.assigneeName} size="sm" />{task.assigneeName.split(' ')[0]}</span>}
                      </span>
                      {task.aiReason && <span className="xs secondary">{task.aiReason}</span>}
                    </div>
                    {task.leadId && task.type === 'call' && (
                      <button
                        type="button"
                        className="btn sm ghost icon"
                        aria-label="Call now"
                        onClick={() => window.salesos?.startCall({ leadId: task.leadId })}
                      >
                        <IconPhone size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </Card>

      <NewTaskModal
        open={showNew}
        onClose={() => {
          setShowNew(false);
          searchParams.delete('new');
          setSearchParams(searchParams, { replace: true });
        }}
        onCreated={refetch}
      />
    </>
  );
}
