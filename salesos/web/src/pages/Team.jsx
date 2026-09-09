import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import {
  PageHeader, Card, Badge, Stat, Spinner, ErrorState, EmptyState, DataTable, Meter, Avatar, Tabs,
} from '../components/UI.jsx';
import { BarChart, LineChart, ScoreRing, StackedBar } from '../components/Charts.jsx';
import {
  IconTarget, IconPhone, IconTrend, IconAlert, IconClock, IconSparkles, IconBookOpen, IconThumb,
} from '../components/Icons.jsx';
import { money, number, percent, titleCase, duration, date, elapsedFromMinutes } from '../lib/format.js';

/**
 * Manager dashboard: team performance, activity, quality and pipeline in one
 * view, filterable by team and period. Every metric here is one an operator can
 * act on -- talk time and connect rate rather than vanity counts.
 */

const PERIODS = [
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: '90', label: 'Quarter' },
];

export default function Team() {
  const [days, setDays] = useState('30');
  const [teamId, setTeamId] = useState('');
  const [tab, setTab] = useState('performance');
  // Memoised so the query key is stable across renders (see Analytics.jsx).
  const since = useMemo(() => new Date(Date.now() - Number(days) * 86400000).toISOString(), [days]);

  const { data, loading, error, refetch } = useApi('/analytics/team', { since, teamId: teamId || undefined });

  if (loading && !data) return <Spinner large label="Loading team performance" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return null;

  const { agents, totals, pipelineByStage, callsByDay, winLoss, objections, dealsAtRisk, teams } = data;
  const sellers = agents.filter((agent) => agent.role === 'agent' || agent.calls > 0 || agent.revenue > 0);

  const columns = [
    {
      key: 'name',
      label: 'Agent',
      render: (agent) => (
        <div className="row-tight">
          <Avatar name={agent.name} size="sm" />
          <div className="col-tight" style={{ gap: 0, minWidth: 0 }}>
            <span className="cell-primary truncate">{agent.name}</span>
            <span className="cell-sub truncate">{agent.teamName || titleCase(agent.role)}</span>
          </div>
        </div>
      ),
    },
    { key: 'calls', label: 'Calls', numeric: true, render: (agent) => <span className="tabular">{number(agent.calls)}</span> },
    { key: 'connect', label: 'Connect', numeric: true, render: (agent) => <span className="tabular">{percent(agent.connectRate)}</span> },
    { key: 'talk', label: 'Talk', numeric: true, render: (agent) => <span className="tabular">{agent.talkMinutes}m</span> },
    { key: 'meetings', label: 'Meetings', numeric: true, render: (agent) => <span className="tabular">{number(agent.meetings)}</span> },
    { key: 'won', label: 'Won', numeric: true, render: (agent) => <span className="tabular">{number(agent.dealsWon)}</span> },
    { key: 'revenue', label: 'Revenue', numeric: true, render: (agent) => <span className="tabular strong">{money(agent.revenue, undefined, { compact: true })}</span> },
    {
      key: 'quota',
      label: 'Quota',
      numeric: true,
      render: (agent) => (agent.quotaAttainment === null
        ? <span className="muted">--</span>
        : (
          <span className="row-tight" style={{ justifyContent: 'flex-end' }}>
            <span className="tabular">{percent(agent.quotaAttainment)}</span>
            <span style={{ width: 40 }}><Meter value={agent.quotaAttainment} tone={agent.quotaAttainment >= 80 ? 'success' : 'warning'} /></span>
          </span>
        )),
    },
    {
      key: 'score',
      label: 'Call score',
      numeric: true,
      render: (agent) => (agent.avgCallScore
        ? <Badge tone={agent.avgCallScore >= 70 ? 'success' : agent.avgCallScore >= 55 ? 'warning' : 'danger'}>{agent.avgCallScore}</Badge>
        : <span className="muted">--</span>),
    },
    {
      key: 'talkRatio',
      label: 'Talk ratio',
      numeric: true,
      render: (agent) => (agent.avgTalkRatio
        ? <span className={`tabular ${agent.avgTalkRatio > 0.6 ? 'strong' : ''}`} style={agent.avgTalkRatio > 0.6 ? { color: 'var(--warning)' } : undefined}>
          {percent(agent.avgTalkRatio * 100)}
        </span>
        : <span className="muted">--</span>),
    },
    {
      key: 'response',
      label: 'Response',
      numeric: true,
      render: (agent) => (agent.responseMinutes !== null && agent.responseMinutes !== undefined
        ? <span className="tabular" title={`${Math.round(agent.responseMinutes)} minutes`}>{elapsedFromMinutes(agent.responseMinutes)}</span>
        : <span className="muted">--</span>),
    },
    {
      key: 'followUp',
      label: 'Follow-up',
      numeric: true,
      render: (agent) => (agent.followUpCompletion === null || agent.followUpCompletion === undefined
        ? <span className="muted">--</span>
        : (
          <span className="row-tight" style={{ justifyContent: 'flex-end' }}>
            <span className="tabular">{percent(agent.followUpCompletion)}</span>
            {agent.overdueTasks > 0 && <Badge tone="danger">{agent.overdueTasks} overdue</Badge>}
          </span>
        )),
    },
  ];

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={`${sellers.length} sellers · ${number(totals.calls)} calls · ${money(totals.revenue)} closed`}
        actions={(
          <>
            <select className="select" style={{ maxWidth: 220 }} value={teamId} onChange={(event) => setTeamId(event.target.value)} aria-label="Filter by team">
              <option value="">All teams</option>
              {(teams || []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
            <div className="pill-tabs">
              {PERIODS.map((period) => (
                <button key={period.key} type="button" className={days === period.key ? 'active' : ''} onClick={() => setDays(period.key)}>
                  {period.label}
                </button>
              ))}
            </div>
            <Link to="/coaching" className="btn"><IconBookOpen /> Coaching</Link>
          </>
        )}
      />

      <div className="grid grid-4">
        <Stat label="Revenue" value={money(totals.revenue, undefined, { compact: true })} meta={`${totals.dealsWon} deals won`} icon={<IconTrend />} />
        <Stat label="Pipeline" value={money(totals.pipeline, undefined, { compact: true })} meta={`${money(totals.weightedForecast, undefined, { compact: true })} weighted`} icon={<IconTarget />} />
        <Stat label="Calls" value={number(totals.calls)} meta={`${percent(totals.calls ? (totals.connected / totals.calls) * 100 : 0)} connect · ${totals.talkHours}h talk`} icon={<IconPhone />} />
        <Stat
          label="Quota attainment"
          value={totals.quota ? percent((totals.revenue / totals.quota) * 100) : '--'}
          meta={totals.quota ? `of ${money(totals.quota, undefined, { compact: true })}` : 'no quotas set'}
          icon={<IconClock />}
        />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'performance', label: 'Performance' },
          { key: 'activity', label: 'Activity' },
          { key: 'quality', label: 'Conversation quality' },
          { key: 'risk', label: 'Risk', count: dealsAtRisk.length },
        ]}
      />

      {tab === 'performance' && (
        <>
          <Card title="Agent leaderboard" flush>
            {/* These rows are per-agent aggregates keyed by userId, not records
                with an id, so the identity has to be named explicitly. */}
            <DataTable
              columns={columns}
              rows={sellers}
              rowKey={(agent) => agent.userId}
              empty={<EmptyState title="No agent activity in this period" />}
            />
          </Card>
          <div className="grid grid-2">
            <Card title="Pipeline by stage">
              <StackedBar segments={pipelineByStage.filter((s) => !s.terminal && s.value > 0).map((stage) => ({ label: stage.label, value: stage.value }))} />
              <BarChart
                horizontal
                data={pipelineByStage.filter((stage) => !stage.terminal).map((stage) => ({ label: stage.label, value: stage.deals }))}
              />
            </Card>
            <Card title="Win / loss" subtitle={`${percent(winLoss.winRate)} win rate`}>
              <div className="grid grid-2">
                <Stat label="Won" value={money(winLoss.wonValue, undefined, { compact: true })} meta={`${winLoss.wonCount} deals`} accent="var(--success)" />
                <Stat label="Lost" value={money(winLoss.lostValue, undefined, { compact: true })} meta={`${winLoss.lostCount} deals`} accent="var(--danger)" />
              </div>
              {winLoss.reasons.slice(0, 5).map((reason) => (
                <div key={reason.reason} className="between small">
                  <span className="truncate">{reason.reason}</span>
                  <span className="row-tight"><Badge tone="outline">{reason.count}</Badge><span className="tabular muted">{money(reason.value, undefined, { compact: true })}</span></span>
                </div>
              ))}
            </Card>
          </div>
        </>
      )}

      {tab === 'activity' && (
        <>
          <Card title="Calls per day">
            {callsByDay.length === 0 ? <EmptyState title="No calls in this period" /> : (
              <LineChart
                height={210}
                xLabels={callsByDay.map((row) => row.day)}
                series={[
                  { label: 'Calls', points: callsByDay.map((row) => row.calls), fill: true },
                  { label: 'Connected', points: callsByDay.map((row) => row.connected), color: 'var(--success)' },
                ]}
              />
            )}
          </Card>
          <div className="grid grid-2">
            <Card title="Talk time by agent">
              <BarChart horizontal data={sellers.map((agent) => ({ label: agent.name, value: agent.talkMinutes }))} format={(v) => `${v}m`} />
            </Card>
            <Card title="Lead response time" subtitle="Minutes to first contact after a lead arrives">
              <BarChart
                horizontal
                data={sellers.filter((agent) => agent.responseMinutes).map((agent) => ({
                  label: agent.name,
                  value: Math.round(agent.responseMinutes),
                  color: agent.responseMinutes > 240 ? 'var(--danger)' : agent.responseMinutes > 60 ? 'var(--warning)' : 'var(--success)',
                }))}
                format={(v) => elapsedFromMinutes(v)}
              />
              <span className="xs muted">Speed to first contact is the strongest single predictor of conversion.</span>
            </Card>
          </div>
        </>
      )}

      {tab === 'quality' && (
        <div className="grid grid-main">
          <Card title="Objections across the team" subtitle={`From ${objections.totalCallsAnalysed} analysed calls`}>
            {!objections.objections.length ? <EmptyState title="No analysed calls yet" /> : (
              <div className="col">
                {objections.objections.map((entry) => (
                  <div key={entry.category} className="col-tight" style={{ gap: 3 }}>
                    <div className="between">
                      <span className="small strong">{titleCase(entry.category)}</span>
                      <span className="row-tight xs">
                        <Badge tone="outline">{entry.count} calls</Badge>
                        <Badge tone={entry.unhandledRate > 40 ? 'danger' : 'success'}>{entry.unhandledRate}% unhandled</Badge>
                      </span>
                    </div>
                    <Meter value={entry.shareOfCalls} tone={entry.unhandledRate > 40 ? 'danger' : undefined} />
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Call scores">
            <div className="col-tight">
              {sellers.filter((agent) => agent.avgCallScore).sort((a, b) => b.avgCallScore - a.avgCallScore).map((agent) => (
                <div key={agent.userId} className="between">
                  <span className="row-tight small"><Avatar name={agent.name} size="sm" />{agent.name}</span>
                  <div className="row-tight">
                    <span className="xs muted">{agent.callsAnalysed} analysed</span>
                    <ScoreRing score={agent.avgCallScore} size={38} thickness={4} />
                  </div>
                </div>
              ))}
              {!sellers.some((agent) => agent.avgCallScore) && <EmptyState title="No scored calls yet" />}
            </div>
            <Link to="/coaching" className="btn"><IconBookOpen /> Open coaching detail</Link>
          </Card>
        </div>
      )}

      {tab === 'risk' && (
        <Card title="Deals at risk across the team">
          {!dealsAtRisk.length ? <EmptyState title="Nothing flagged" message="Every open deal has recent contact and a next step." /> : (
            <DataTable
              rowKey={(deal) => deal.dealId}
              columns={[
                { key: 'name', label: 'Deal', render: (deal) => <Link to={`/pipeline?deal=${deal.dealId}`} className="cell-primary">{deal.name}</Link> },
                { key: 'owner', label: 'Owner', render: (deal) => <span className="small">{deal.ownerName || '--'}</span> },
                { key: 'stage', label: 'Stage', render: (deal) => <Badge tone="outline">{titleCase(deal.stage)}</Badge> },
                { key: 'value', label: 'Value', numeric: true, render: (deal) => <span className="tabular">{money(deal.value, undefined, { compact: true })}</span> },
                { key: 'risk', label: 'Risk', numeric: true, render: (deal) => <Badge tone={deal.health === 'at_risk' ? 'danger' : 'warning'}>{deal.riskScore}</Badge> },
                { key: 'reason', label: 'Why', render: (deal) => <span className="small truncate" title={deal.reasons.join('; ')}>{deal.reasons[0]}</span> },
                { key: 'action', label: 'Recommended', render: (deal) => <span className="small secondary truncate">{deal.recommendedAction}</span> },
              ]}
              rows={dealsAtRisk}
            />
          )}
        </Card>
      )}
    </>
  );
}
