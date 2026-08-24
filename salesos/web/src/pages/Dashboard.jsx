import { Link, useOutletContext } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useRealtimeEvent } from '../lib/realtime.jsx';
import {
  Card, Stat, PageHeader, Badge, EmptyState, ErrorState, Skeleton, Avatar, Meter, useToast,
} from '../components/UI.jsx';
import { StackedBar, ScoreRing, DonutChart } from '../components/Charts.jsx';
import {
  IconPhone, IconPlus, IconMail, IconCalendar, IconNote, IconPipeline, IconSparkles,
  IconTask, IconTrend, IconAlert, IconCheck, IconChevronRight, IconTarget, IconWave,
} from '../components/Icons.jsx';
import { money, number, duration, dayLabel, relative, titleCase, percent } from '../lib/format.js';
import api from '../lib/api.js';

/**
 * Sales agent dashboard.
 *
 * Ordered by what an agent actually does at 9am: what the AI thinks they should
 * do, what is overdue, then the numbers. Quick actions are one click from here
 * because the alternative is four clicks through a menu.
 */

function QuickActions({ onCall, onAddLead, onAskAi }) {
  const actions = [
    { label: 'Call lead', icon: <IconPhone />, onClick: onCall, primary: true },
    { label: 'Add lead', icon: <IconPlus />, to: '/leads?new=1' },
    { label: 'Send email', icon: <IconMail />, to: '/inbox?compose=1' },
    { label: 'Schedule follow-up', icon: <IconCalendar />, to: '/tasks?new=1' },
    { label: 'Add note', icon: <IconNote />, to: '/leads' },
    { label: 'Update deal', icon: <IconPipeline />, to: '/pipeline' },
  ];
  return (
    <div className="row wrap gap-2">
      {actions.map((action) => (action.to ? (
        <Link key={action.label} to={action.to} className={`btn ${action.primary ? 'primary' : ''}`}>
          {action.icon} {action.label}
        </Link>
      ) : (
        <button key={action.label} type="button" className={`btn ${action.primary ? 'primary' : ''}`} onClick={action.onClick}>
          {action.icon} {action.label}
        </button>
      )))}
      <button type="button" className="btn subtle" onClick={() => onAskAi('What should I focus on today?')}>
        <IconSparkles /> Ask AI what to focus on
      </button>
    </div>
  );
}

function CallListCard({ items, onCall }) {
  if (!items?.length) {
    return (
      <Card title="Who to call today">
        <EmptyState
          icon={<IconCheck size={20} />}
          title="Nothing overdue"
          message="Your follow-ups are current and every new lead has been touched."
        />
      </Card>
    );
  }
  return (
    <Card
      title="Who to call today"
      subtitle="Ranked by urgency and deal value"
      actions={<Badge tone="accent"><IconSparkles size={11} /> AI ranked</Badge>}
    >
      <ol className="list-plain">
        {items.map((entry) => (
          <li key={entry.leadId} className="row gap-2" style={{ alignItems: 'flex-start' }}>
            <span
              className="avatar sm"
              style={{ background: 'var(--bg-active)', color: 'var(--text-secondary)', fontWeight: 700 }}
              aria-hidden
            >
              {entry.rank}
            </span>
            <div className="grow col-tight" style={{ gap: 2, minWidth: 0 }}>
              <div className="row-tight wrap">
                <Link to={`/leads/${entry.leadId}`} className="strong truncate">{entry.name || 'Unknown contact'}</Link>
                {entry.company && <span className="small muted truncate">{entry.company}</span>}
                {entry.value > 0 && <Badge tone="outline">{money(entry.value, undefined, { compact: true })}</Badge>}
                {entry.temperature && <Badge tone={entry.temperature}>{entry.temperature}</Badge>}
              </div>
              <span className="xs secondary">{entry.reasons.join(' · ')}</span>
            </div>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => onCall({ leadId: entry.leadId })}
              aria-label={`Call ${entry.name}`}
            >
              <IconPhone size={13} /> Call
            </button>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function Dashboard() {
  const { user, settings } = useAuth();
  const { startCall, askAi } = useOutletContext();
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/analytics/dashboard');

  // Live: a completed call or a new AI analysis changes these numbers.
  useRealtimeEvent('call.ended', () => refetch());
  useRealtimeEvent('analysis.ready', () => refetch());
  useRealtimeEvent('activity.created', () => refetch());

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Loading your day" />
        <div className="grid grid-4">{Array.from({ length: 4 }).map((_, i) => <Card key={i}><Skeleton rows={2} /></Card>)}</div>
      </>
    );
  }
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  const { today, leads, followUps, tasks, deals, quota, conversations, callList, pendingApprovals } = data;
  const connectRate = today.callsMade ? Math.round((today.callsConnected / today.callsMade) * 100) : 0;
  const firstName = user?.name?.split(' ')[0] || 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const call = async (payload) => {
    const result = await startCall(payload);
    if (result) toast.success(`Dialling ${result.lead?.name || 'the contact'}`);
  };

  return (
    <>
      <PageHeader
        title={`${greeting}, ${firstName}`}
        subtitle={`${dayLabel(new Date())} · ${today.callsMade} calls made · ${followUps.pending} follow-ups due · ${tasks.dueToday} tasks today`}
        actions={<QuickActions onCall={() => call({})} onAskAi={askAi} />}
      />

      {pendingApprovals > 0 && (
        <div className="banner">
          <IconSparkles />
          <div className="grow">
            <strong>{pendingApprovals} AI CRM update{pendingApprovals === 1 ? '' : 's'} waiting for your approval</strong>
            <div className="small secondary">
              Extracted from your recent calls. {settings?.crmApproval?.mode === 'auto'
                ? 'High-confidence changes were applied automatically; these need a human.'
                : 'Nothing is applied until you approve it.'}
            </div>
          </div>
          <Link to="/approvals" className="btn primary sm">Review updates</Link>
        </div>
      )}

      {/* Row 1: today's activity */}
      <div className="grid grid-4">
        <Stat
          label="Calls today"
          value={number(today.callsMade)}
          meta={`${today.callsConnected} connected · ${connectRate}% connect rate`}
          icon={<IconPhone />}
        />
        <Stat
          label="Talk time"
          value={`${today.talkMinutes}m`}
          meta={today.callsConnected
            ? `${Math.round(today.talkMinutes / today.callsConnected)}m average per connect`
            : `${today.callsMade} of ${today.callTarget} calls today`}
          icon={<IconWave />}
        />
        <Stat
          label="Calls missed"
          value={number(today.callsMissed)}
          meta={today.callsMissed ? 'Return these first' : 'None missed'}
          accent={today.callsMissed ? 'var(--danger)' : undefined}
          icon={<IconAlert />}
        />
        <Stat
          label="Follow-ups pending"
          value={number(followUps.pending)}
          meta={followUps.overdue ? `${followUps.overdue} overdue` : 'All current'}
          accent={followUps.overdue ? 'var(--warning)' : undefined}
          icon={<IconTask />}
        />
      </div>

      {/* Row 2: the AI call list next to the pipeline */}
      <div className="grid grid-main">
        <CallListCard items={callList} onCall={call} />

        <div className="col">
          <Card title="Pipeline" actions={<Link to="/pipeline" className="btn sm ghost">Open board <IconChevronRight size={13} /></Link>}>
            <div className="between">
              <div className="col-tight" style={{ gap: 0 }}>
                <span className="stat-value sm">{money(deals.pipelineValue, undefined, { compact: true })}</span>
                <span className="small muted">{deals.open} open deals</span>
              </div>
              <div className="col-tight" style={{ gap: 0, alignItems: 'flex-end' }}>
                <span className="strong tabular">{money(deals.weightedForecast, undefined, { compact: true })}</span>
                <span className="small muted">weighted forecast</span>
              </div>
            </div>
            <StackedBar
              segments={deals.byStage.filter((s) => s.value > 0).map((stage) => ({ label: stage.label, value: stage.value }))}
            />
          </Card>

          <Card title="Quota this month">
            <div className="row gap-4">
              <ScoreRing score={quota.target ? (quota.achieved / quota.target) * 100 : 0} size={72} label="Quota attainment" />
              <div className="grow col-tight">
                <div className="between">
                  <span className="small muted">Closed</span>
                  <span className="strong tabular">{money(quota.achieved)}</span>
                </div>
                <div className="between">
                  <span className="small muted">Quota</span>
                  <span className="tabular">{money(quota.target)}</span>
                </div>
                <Meter
                  value={quota.target ? (quota.achieved / quota.target) * 100 : 0}
                  tone={quota.target && quota.achieved / quota.target >= 0.8 ? 'success' : 'warning'}
                />
                <span className="xs muted">{deals.wonThisMonth} deals won in the last 30 days</span>
              </div>
            </div>
          </Card>

          <Card title="Lead mix">
            <DonutChart
              size={116}
              thickness={14}
              centerValue={number(leads.total)}
              centerLabel="leads"
              data={[
                { label: 'Hot', value: leads.hot, color: 'var(--hot)' },
                { label: 'Warm', value: leads.warm, color: 'var(--warm)' },
                { label: 'Cold', value: leads.cold, color: 'var(--cold)' },
              ]}
            />
            <div className="row-tight wrap xs muted">
              <span>{leads.new} new</span>
              <span>·</span>
              <span>{leads.newThisWeek} added this week</span>
              {leads.uncontacted > 0 && (
                <>
                  <span>·</span>
                  <Link to="/leads?notContacted=1">{leads.uncontacted} never contacted</Link>
                </>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Row 3: tasks, follow-ups, conversations */}
      <div className="grid grid-3">
        <Card
          title="Tasks due"
          subtitle={tasks.overdue ? `${tasks.overdue} overdue` : `${tasks.open} open`}
          actions={<Link to="/tasks" className="btn sm ghost">All tasks</Link>}
        >
          {tasks.list.length === 0 ? (
            <EmptyState icon={<IconCheck size={18} />} title="Nothing due" message="No open tasks for today." />
          ) : (
            <ul className="list-plain">
              {tasks.list.map((task) => (
                <li key={task.id} className="row gap-2" style={{ alignItems: 'flex-start' }}>
                  <button
                    type="button"
                    className="btn ghost icon sm"
                    title="Mark complete"
                    aria-label={`Complete ${task.title}`}
                    onClick={async () => {
                      await api.post(`/tasks/${task.id}/complete`);
                      toast.success('Task completed');
                      refetch();
                    }}
                  >
                    <IconCheck size={14} />
                  </button>
                  <div className="grow col-tight" style={{ gap: 1, minWidth: 0 }}>
                    <span className="small strong truncate">{task.title}</span>
                    <span className="xs muted row-tight wrap">
                      <Badge tone={task.priority === 'urgent' ? 'danger' : task.priority === 'high' ? 'warning' : 'outline'}>
                        {task.priority}
                      </Badge>
                      {task.source === 'ai' && <Badge tone="accent"><IconSparkles size={10} /> AI</Badge>}
                      <span>{relative(task.dueAt)}</span>
                      {task.companyName && <span className="truncate">· {task.companyName}</span>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Upcoming follow-ups" actions={<Link to="/leads?followUp=1" className="btn sm ghost">View all</Link>}>
          {followUps.upcoming.length === 0 ? (
            <EmptyState icon={<IconCalendar size={18} />} title="No follow-ups scheduled" />
          ) : (
            <ul className="list-plain">
              {followUps.upcoming.map((entry) => (
                <li key={entry.leadId} className="between">
                  <div className="col-tight" style={{ gap: 1, minWidth: 0 }}>
                    <Link to={`/leads/${entry.leadId}`} className="small strong truncate">{entry.name}</Link>
                    <span className="xs muted truncate">{entry.company}</span>
                  </div>
                  <div className="row-tight">
                    <Badge tone={entry.temperature}>{entry.temperature}</Badge>
                    <span className="xs muted nowrap">{dayLabel(entry.at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Recent conversations"
          actions={<Link to="/conversations" className="btn sm ghost">All conversations</Link>}
        >
          {conversations.length === 0 ? (
            <EmptyState icon={<IconWave size={18} />} title="No analysed calls yet" message="Make a recorded call and the AI will summarise it here." />
          ) : (
            <ul className="list-plain">
              {conversations.map((conversation) => (
                <li key={conversation.callId} className="col-tight" style={{ gap: 3 }}>
                  <div className="between">
                    <Link to={`/conversations/${conversation.callId}`} className="small strong truncate">
                      {conversation.contactName || 'Unknown contact'}
                      {conversation.companyName ? <span className="muted"> · {conversation.companyName}</span> : null}
                    </Link>
                    <div className="row-tight">
                      {conversation.sentiment && <Badge tone={conversation.sentiment}>{conversation.sentiment}</Badge>}
                      {conversation.score !== null && conversation.score !== undefined && (
                        <span className="xs muted tabular" title="Call score">{conversation.score}</span>
                      )}
                    </div>
                  </div>
                  <span className="xs secondary" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {conversation.summary}
                  </span>
                  <span className="xs muted">{relative(conversation.startedAt)} · {duration(conversation.durationSeconds)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {deals.closingSoon?.length > 0 && (
        <Card title="Closing in the next 30 days" actions={<Link to="/pipeline" className="btn sm ghost">Pipeline</Link>}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Stage</th>
                  <th className="num">Value</th>
                  <th className="num">Probability</th>
                  <th>Expected close</th>
                </tr>
              </thead>
              <tbody>
                {deals.closingSoon.map((deal) => (
                  <tr key={deal.id}>
                    <td className="cell-primary truncate">{deal.name}</td>
                    <td><Badge tone="outline">{titleCase(deal.stage)}</Badge></td>
                    <td className="num tabular">{money(deal.value)}</td>
                    <td className="num tabular">{percent(deal.probability)}</td>
                    <td className="nowrap">{dayLabel(deal.expected_close_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
