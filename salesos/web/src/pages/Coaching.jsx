import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader, Card, Badge, Stat, Spinner, ErrorState, EmptyState, Tabs, Meter, Avatar, DataTable,
} from '../components/UI.jsx';
import { ScoreRing, LineChart, BarChart } from '../components/Charts.jsx';
import { IconBookOpen, IconAlert, IconThumb, IconTarget, IconSparkles, IconWave } from '../components/Icons.jsx';
import { number, percent, titleCase, relative, duration, date } from '../lib/format.js';

/**
 * Call quality and coaching.
 *
 * Every score traces back to a specific conversation a manager can listen to,
 * which is the difference between coaching and opinion. The lowest-scoring calls
 * are surfaced first because that is where the coaching value is.
 */
export default function Coaching() {
  const { isManager, user } = useAuth();
  const [tab, setTab] = useState('team');
  const [agentId, setAgentId] = useState(isManager ? '' : user?.id);

  const overview = useApi('/coaching/overview');
  const calls = useApi('/coaching/calls', { agentId: agentId || undefined, limit: 25 });
  const agentDetail = useApi(agentId ? `/coaching/agents/${agentId}` : null);

  if (overview.loading && !overview.data) return <Spinner large label="Loading coaching data" />;
  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.refetch} />;

  const data = overview.data;
  const dimensions = data?.dimensions || [];

  return (
    <>
      <PageHeader
        title="Call quality and coaching"
        subtitle={`${number(data?.callsAnalysed || 0)} analysed calls since ${date(data?.since)}`}
        actions={isManager && (
          <select className="select" style={{ maxWidth: 240 }} value={agentId} onChange={(event) => setAgentId(event.target.value)} aria-label="Choose agent">
            <option value="">Whole team</option>
            {(data?.agents || []).map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.agentName}</option>)}
          </select>
        )}
      />

      <div className="grid grid-4">
        <Stat
          label="Team average score"
          value={data?.agents?.length ? Math.round(data.agents.reduce((sum, a) => sum + a.averageScore, 0) / data.agents.length) : '--'}
          meta="0-100 weighted across dimensions"
          icon={<IconTarget />}
        />
        <Stat
          label="Weakest dimension"
          value={data?.weakestDimension?.average ?? '--'}
          meta={data?.weakestDimension?.label || 'not enough data'}
          accent="var(--warning)"
          icon={<IconAlert />}
        />
        <Stat label="Calls analysed" value={number(data?.callsAnalysed || 0)} icon={<IconWave />} />
        <Stat
          label="Average talk ratio"
          value={data?.agents?.length
            ? percent((data.agents.reduce((sum, a) => sum + (a.averageTalkRatio || 0), 0) / data.agents.length) * 100)
            : '--'}
          meta="target 40-50%"
          icon={<IconThumb />}
        />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'team', label: 'By agent' },
          { key: 'dimensions', label: 'By dimension' },
          { key: 'calls', label: 'Calls to review', count: calls.data?.calls?.length },
          ...(agentId ? [{ key: 'agent', label: 'Agent detail' }] : []),
        ]}
      />

      {tab === 'team' && (
        <div className="col">
          {!data?.agents?.length ? (
            <EmptyState icon={<IconBookOpen size={20} />} title="No analysed calls yet" message="Record a call and coaching scores appear here automatically." />
          ) : data.agents.map((agent) => (
            <Card key={agent.agentId}>
              <div className="between wrap gap-4">
                <div className="row gap-4">
                  <ScoreRing score={agent.averageScore} size={64} thickness={6} label={`${agent.agentName} average`} />
                  <div className="col-tight" style={{ gap: 2 }}>
                    <div className="row-tight">
                      <Avatar name={agent.agentName} size="sm" />
                      <strong>{agent.agentName}</strong>
                      <Badge tone="outline">{agent.callsAnalysed} calls</Badge>
                      {agent.averageTalkRatio > 0.6 && <Badge tone="warning">talks {percent(agent.averageTalkRatio * 100)}</Badge>}
                    </div>
                    {agent.topStrengths[0] && <span className="xs secondary">Strength: {agent.topStrengths[0].text}</span>}
                    {agent.topImprovements[0] && <span className="xs secondary">Focus: {agent.topImprovements[0].text}</span>}
                  </div>
                </div>
                <div className="row-tight">
                  {agent.bestCall && <Link to={`/conversations/${agent.bestCall.callId}`} className="btn sm ghost">Best call ({agent.bestCall.score})</Link>}
                  {agent.worstCall && <Link to={`/conversations/${agent.worstCall.callId}`} className="btn sm">Review lowest ({agent.worstCall.score})</Link>}
                  <button type="button" className="btn sm" onClick={() => { setAgentId(agent.agentId); setTab('agent'); }}>Detail</button>
                </div>
              </div>

              <div className="grid grid-4">
                {dimensions.map((dimension) => (
                  <Meter
                    key={dimension.key}
                    label={dimension.label}
                    value={agent.dimensions[dimension.key] ?? 0}
                    tone={(agent.dimensions[dimension.key] ?? 0) >= 70 ? 'success' : (agent.dimensions[dimension.key] ?? 0) >= 50 ? 'warning' : 'danger'}
                  />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === 'dimensions' && (
        <div className="grid grid-main">
          <Card title="Team average by dimension" subtitle="The lowest bar is where coaching pays back fastest">
            <BarChart
              horizontal
              data={(data?.teamDimensions || []).filter((entry) => entry.average !== null).map((entry) => ({
                label: entry.label,
                value: entry.average,
                color: entry.average >= 70 ? 'var(--success)' : entry.average >= 50 ? 'var(--warning)' : 'var(--danger)',
              }))}
            />
          </Card>
          <Card title="What each dimension measures">
            <dl className="kv">
              <dt>Opening</dt><dd className="small">Purpose stated, time respected, recording consent handled.</dd>
              <dt>Discovery</dt><dd className="small">Open questions that make the customer describe their own problem.</dd>
              <dt>Product knowledge</dt><dd className="small">Specific, confident answers rather than hedging.</dd>
              <dt>Objection handling</dt><dd className="small">Objections acknowledged and answered with a concrete option.</dd>
              <dt>Listening</dt><dd className="small">Talk ratio near 40-50% agent.</dd>
              <dt>Engagement</dt><dd className="small">How much the customer actually said and asked.</dd>
              <dt>Closing</dt><dd className="small">A specific proposal rather than "shall I follow up?".</dd>
              <dt>Next-step confirmation</dt><dd className="small">A dated, mutually agreed next action before hanging up.</dd>
            </dl>
          </Card>
        </div>
      )}

      {tab === 'calls' && (
        <Card title="Calls worth reviewing" subtitle="Lowest scores first" flush>
          {calls.loading ? <div className="card-body-pad"><Spinner /></div> : (
            <DataTable
              columns={[
                {
                  key: 'score',
                  label: 'Score',
                  render: (call) => <ScoreRing score={call.scorecard?.overall || 0} size={38} thickness={4} />,
                },
                {
                  key: 'contact',
                  label: 'Conversation',
                  render: (call) => (
                    <div className="col-tight" style={{ gap: 0, minWidth: 0 }}>
                      <Link to={`/conversations/${call.callId}`} className="cell-primary truncate">{call.contactName || 'Unknown'}</Link>
                      <span className="cell-sub truncate">{call.companyName}</span>
                    </div>
                  ),
                },
                { key: 'agent', label: 'Agent', render: (call) => <span className="small">{call.agentName}</span> },
                { key: 'sentiment', label: 'Sentiment', render: (call) => (call.sentiment ? <Badge tone={call.sentiment}>{call.sentiment}</Badge> : '--') },
                {
                  key: 'talk',
                  label: 'Talk ratio',
                  numeric: true,
                  render: (call) => <span className="tabular">{call.talkRatio ? percent(call.talkRatio * 100) : '--'}</span>,
                },
                {
                  key: 'weakness',
                  label: 'Primary gap',
                  render: (call) => <span className="small secondary truncate">{call.coaching?.improvements?.[0] || '--'}</span>,
                },
                { key: 'when', label: 'When', render: (call) => <span className="small nowrap">{relative(call.startedAt)}</span> },
              ]}
              rows={calls.data?.calls || []}
              rowKey={(call) => call.callId}
              empty={<EmptyState title="No calls to review" />}
            />
          )}
        </Card>
      )}

      {tab === 'agent' && agentDetail.data && (
        <div className="grid grid-main">
          <div className="col">
            <Card title={`${agentDetail.data.agent.name} — score trend`} subtitle={`${agentDetail.data.callsAnalysed} analysed calls`}>
              {agentDetail.data.trend.length < 2 ? <EmptyState title="Not enough calls to show a trend" /> : (
                <LineChart
                  height={200}
                  xLabels={agentDetail.data.trend.map((point) => date(point.at, { year: undefined }))}
                  series={[
                    { label: 'Overall', points: agentDetail.data.trend.map((point) => point.overall), fill: true },
                    { label: 'Discovery', points: agentDetail.data.trend.map((point) => point.discovery ?? 0), color: 'var(--purple)' },
                    { label: 'Objection handling', points: agentDetail.data.trend.map((point) => point.objection_handling ?? 0), color: 'var(--warning)' },
                  ]}
                />
              )}
            </Card>

            <Card title="Objection handling by category">
              {!agentDetail.data.objectionHandling.length ? <EmptyState title="No objections recorded" /> : (
                <div className="col-tight">
                  {agentDetail.data.objectionHandling.map((entry) => (
                    <div key={entry.category} className="col-tight" style={{ gap: 3 }}>
                      <div className="between small">
                        <span>{titleCase(entry.category)}</span>
                        <span className="row-tight">
                          <span className="tabular muted">{entry.handled}/{entry.total} handled</span>
                          <Badge tone={entry.handledRate >= 70 ? 'success' : entry.handledRate >= 40 ? 'warning' : 'danger'}>
                            {percent(entry.handledRate)}
                          </Badge>
                        </span>
                      </div>
                      <Meter value={entry.handledRate} tone={entry.handledRate >= 70 ? 'success' : 'warning'} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className="col">
            <Card title="Coaching priorities" subtitle="Repeated across recent calls">
              {!agentDetail.data.recommendations.length ? <EmptyState title="Nothing recurring" /> : (
                <div className="col-tight">
                  {agentDetail.data.recommendations.map((entry, index) => (
                    <div key={index} className="col-tight" style={{ gap: 2 }}>
                      <div className="row-tight">
                        <Badge tone={entry.priority === 'high' ? 'danger' : entry.priority === 'medium' ? 'warning' : 'outline'}>
                          {entry.priority}
                        </Badge>
                        <span className="xs muted">{entry.appearedInCalls} calls</span>
                      </div>
                      <span className="small">{entry.recommendation}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {agentDetail.data.latestCoaching && (
              <Card title="Most recent call feedback">
                {agentDetail.data.latestCoaching.recommendation && (
                  <p className="small" style={{ margin: 0 }}>{agentDetail.data.latestCoaching.recommendation}</p>
                )}
                {(agentDetail.data.latestCoaching.strengths || []).length > 0 && (
                  <>
                    <span className="uppercase muted">Worked well</span>
                    <ul className="list-bullets small">
                      {agentDetail.data.latestCoaching.strengths.map((item, index) => <li key={index}>{item}</li>)}
                    </ul>
                  </>
                )}
                {(agentDetail.data.latestCoaching.improvements || []).length > 0 && (
                  <>
                    <span className="uppercase muted">To change</span>
                    <ul className="list-bullets small">
                      {agentDetail.data.latestCoaching.improvements.map((item, index) => <li key={index}>{item}</li>)}
                    </ul>
                  </>
                )}
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
