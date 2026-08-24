import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader, Card, Badge, Stat, Spinner, ErrorState, EmptyState, Tabs, Meter,
} from '../components/UI.jsx';
import { BarChart, DonutChart, ScoreRing } from '../components/Charts.jsx';
import {
  IconSparkles, IconAlert, IconTrend, IconTrendDown, IconPhone, IconTarget,
  IconClock, IconThumb, IconRobot, IconChevronRight,
} from '../components/Icons.jsx';
import { money, number, percent, relative, titleCase, date } from '../lib/format.js';

/**
 * AI sales intelligence.
 *
 * Answers the questions a sales team asks every week, each one derived from the
 * organisation's own conversations rather than a generic benchmark: who converts,
 * what is slipping, which objections cost deals, and why deals are lost.
 */

const QUESTIONS = [
  'Which leads are most likely to convert?',
  'Which deals are at risk?',
  'Which leads have not been contacted?',
  'What objections are appearing most frequently?',
  'Why are deals being lost?',
  'Who should I call today?',
];

export default function Insights() {
  const { isManager } = useAuth();
  const { askAi } = useOutletContext();
  const [tab, setTab] = useState('convert');
  const { data, loading, error, refetch } = useApi('/ai/insights');
  const status = useApi('/ai/status');

  if (loading && !data) return <Spinner large label="Analysing your pipeline" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return null;

  const { likelyToConvert, dealsAtRisk, needsFollowUp, neverContacted, objectionTrends, lossAnalysis, callList } = data;

  return (
    <>
      <PageHeader
        title="AI sales intelligence"
        subtitle={`Generated ${relative(data.generatedAt)} from your own conversations and pipeline`}
        actions={(
          <>
            {status.data && (
              <Badge tone={status.data.activeProvider === 'anthropic' ? 'accent' : 'outline'} title={status.data.model}>
                <IconRobot size={11} /> {status.data.activeProvider === 'anthropic' ? status.data.model : 'built-in engine'}
              </Badge>
            )}
            <button type="button" className="btn primary" onClick={() => askAi('What should I focus on this week?')}>
              <IconSparkles /> Ask AI
            </button>
          </>
        )}
      />

      <div className="grid grid-4">
        <Stat
          label="High-conversion leads"
          value={number(likelyToConvert.filter((l) => l.likelihood >= 60).length)}
          meta={`of ${likelyToConvert.length} ranked`}
          icon={<IconTrend />}
        />
        <Stat
          label="Deals at risk"
          value={number(dealsAtRisk.length)}
          meta={money(dealsAtRisk.reduce((sum, d) => sum + (d.value || 0), 0), undefined, { compact: true })}
          accent={dealsAtRisk.length ? 'var(--danger)' : undefined}
          icon={<IconAlert />}
        />
        <Stat
          label="Win rate"
          value={percent(lossAnalysis.winRate)}
          meta={`${lossAnalysis.wonCount} won / ${lossAnalysis.lostCount} lost`}
          icon={<IconTarget />}
        />
        <Stat
          label="Never contacted"
          value={number(neverContacted.length)}
          meta={neverContacted.length ? 'Untouched new leads' : 'All leads touched'}
          accent={neverContacted.length ? 'var(--warning)' : undefined}
          icon={<IconClock />}
        />
      </div>

      <Card title="Ask the assistant" subtitle="Answered from records you are permitted to see">
        <div className="row wrap gap-2">
          {QUESTIONS.map((question) => (
            <button key={question} type="button" className="assistant-chip" onClick={() => askAi(question)}>
              {question}
            </button>
          ))}
        </div>
      </Card>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'convert', label: 'Likely to convert', count: likelyToConvert.length },
          { key: 'risk', label: 'At risk', count: dealsAtRisk.length },
          { key: 'neglected', label: 'Needs contact', count: needsFollowUp.length + neverContacted.length },
          { key: 'objections', label: 'Objections' },
          { key: 'loss', label: 'Win/loss' },
          { key: 'calllist', label: 'Call list', count: callList.length },
        ]}
      />

      {tab === 'convert' && (
        <Card title="Most likely to convert" subtitle="Blends the AI lead score with observed behaviour on calls and email">
          {!likelyToConvert.length ? <EmptyState title="No active leads to rank" /> : (
            <div className="col">
              {likelyToConvert.map((lead) => (
                <div key={lead.leadId} className="between wrap gap-2" style={{ paddingBottom: 'var(--space-3)', borderBottom: '1px solid var(--surface-border)' }}>
                  <div className="row gap-4" style={{ alignItems: 'center', minWidth: 0 }}>
                    <ScoreRing score={lead.likelihood} size={50} thickness={5} label="Conversion likelihood" />
                    <div className="col-tight" style={{ gap: 2, minWidth: 0 }}>
                      <div className="row-tight wrap">
                        <Link to={`/leads/${lead.leadId}`} className="strong">{lead.name}</Link>
                        {lead.company && <span className="small muted">{lead.company}</span>}
                        {lead.temperature && <Badge tone={lead.temperature}>{lead.temperature}</Badge>}
                        {lead.stage && <Badge tone="outline">{titleCase(lead.stage)}</Badge>}
                      </div>
                      <span className="xs muted">
                        {lead.factors.map((factor) => `${factor.label} ${factor.points > 0 ? '+' : ''}${factor.points}`).join(' · ')}
                      </span>
                    </div>
                  </div>
                  <div className="row-tight">
                    {lead.value > 0 && <span className="tabular strong">{money(lead.value, undefined, { compact: true })}</span>}
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={lead.doNotCall}
                      title={lead.doNotCall ? 'This contact is on the do-not-call list' : undefined}
                      onClick={() => window.salesos?.startCall({ leadId: lead.leadId })}
                    >
                      <IconPhone size={13} /> Call
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'risk' && (
        <Card title="Deals at risk" subtitle="Scored on contact recency, stage age, unresolved objections and competition">
          {!dealsAtRisk.length ? <EmptyState title="No deals flagged" message="Every open deal has recent contact and a forward next step." /> : (
            <div className="col">
              {dealsAtRisk.map((deal) => (
                <div key={deal.dealId} className="card" style={{ padding: 'var(--space-3)' }}>
                  <div className="between wrap gap-2">
                    <div className="col-tight" style={{ gap: 2, minWidth: 0 }}>
                      <div className="row-tight wrap">
                        <strong className="truncate">{deal.name}</strong>
                        <Badge tone={deal.health === 'at_risk' ? 'danger' : 'warning'}>{titleCase(deal.health)} · {deal.riskScore}/100</Badge>
                        <Badge tone="outline">{titleCase(deal.stage)}</Badge>
                      </div>
                      <span className="xs muted">
                        {deal.contact}{deal.company ? ` · ${deal.company}` : ''}
                        {deal.ownerName && isManager ? ` · ${deal.ownerName}` : ''}
                        {deal.expectedCloseDate ? ` · closes ${date(deal.expectedCloseDate)}` : ''}
                      </span>
                    </div>
                    <span className="tabular strong">{money(deal.value, undefined, { compact: true })}</span>
                  </div>
                  <ul className="list-bullets small secondary">
                    {deal.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
                  </ul>
                  <div className="banner small">
                    <IconSparkles />
                    <span><strong>Recommended:</strong> {deal.recommendedAction}</span>
                  </div>
                  <div className="row-tight">
                    <Link to={`/pipeline?deal=${deal.dealId}`} className="btn sm">Open deal</Link>
                    {deal.leadId && (
                      <button type="button" className="btn sm primary" onClick={() => window.salesos?.startCall({ leadId: deal.leadId, dealId: deal.dealId })}>
                        <IconPhone size={13} /> Call now
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'neglected' && (
        <div className="grid grid-2">
          <Card title="Never contacted" subtitle="New leads with no outbound attempt">
            {!neverContacted.length ? <EmptyState title="Every lead has been touched" /> : (
              <div className="col-tight">
                {neverContacted.map((lead) => (
                  <div key={lead.leadId} className="between">
                    <div className="col-tight" style={{ gap: 1, minWidth: 0 }}>
                      <Link to={`/leads/${lead.leadId}`} className="small strong truncate">{lead.name}</Link>
                      <span className="xs muted truncate">{lead.company} · {titleCase(lead.source || 'unknown source')}</span>
                    </div>
                    <div className="row-tight">
                      <Badge tone={lead.ageHours > 48 ? 'danger' : 'outline'}>{lead.ageLabel ?? `${lead.ageHours}h`} old</Badge>
                      <button type="button" className="btn sm ghost icon" aria-label="Call" onClick={() => window.salesos?.startCall({ leadId: lead.leadId })}>
                        <IconPhone size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Going cold" subtitle="No contact in the last two weeks">
            {!needsFollowUp.length ? <EmptyState title="All contacts are current" /> : (
              <div className="col-tight">
                {needsFollowUp.map((lead) => (
                  <div key={lead.leadId} className="between">
                    <div className="col-tight" style={{ gap: 1, minWidth: 0 }}>
                      <Link to={`/leads/${lead.leadId}`} className="small strong truncate">{lead.name}</Link>
                      <span className="xs muted truncate">{lead.company}</span>
                    </div>
                    <div className="row-tight">
                      <Badge tone={lead.temperature}>{lead.temperature}</Badge>
                      <span className="xs muted nowrap">{lead.daysSinceContact ?? '--'}d</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'objections' && (
        <div className="grid grid-main">
          <Card title="Objection frequency" subtitle={`Across ${objectionTrends.totalCallsAnalysed} analysed calls`}>
            {!objectionTrends.objections.length ? <EmptyState title="No objections detected yet" /> : (
              <div className="col">
                <BarChart
                  horizontal
                  data={objectionTrends.objections.map((entry) => ({ label: titleCase(entry.category), value: entry.count }))}
                />
                <hr className="divider" />
                {objectionTrends.objections.map((entry) => (
                  <div key={entry.category} className="col-tight" style={{ gap: 3 }}>
                    <div className="between">
                      <span className="strong small">{titleCase(entry.category)}</span>
                      <span className="row-tight xs">
                        <Badge tone="outline">{entry.count} calls</Badge>
                        <Badge tone={entry.unhandledRate > 40 ? 'danger' : 'success'}>{entry.unhandledRate}% unhandled</Badge>
                        {entry.commonStage && <Badge tone="outline">mostly at {titleCase(entry.commonStage)}</Badge>}
                      </span>
                    </div>
                    {entry.examples[0] && <blockquote className="suggestion-evidence">“{entry.examples[0]}”</blockquote>}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="What to do about it">
            <p className="small secondary" style={{ margin: 0 }}>
              The number that matters is the unhandled rate, not the count. A frequent objection your team
              answers well is a qualification step; a frequent objection they do not answer is lost revenue.
            </p>
            {objectionTrends.objections.filter((entry) => entry.unhandledRate > 40).slice(0, 3).map((entry) => (
              <div key={entry.category} className="banner warning small">
                <IconAlert />
                <span>
                  <strong>{titleCase(entry.category)}</strong> goes unanswered on {entry.unhandledRate}% of the calls it
                  appears in. Build a response into the team&apos;s talk track and review it in coaching.
                </span>
              </div>
            ))}
            <Link to="/coaching" className="btn">Open coaching <IconChevronRight size={13} /></Link>
          </Card>
        </div>
      )}

      {tab === 'loss' && (
        <div className="grid grid-main">
          <Card title="Why deals are lost">
            {!lossAnalysis.reasons.length ? <EmptyState title="No closed-lost deals recorded" /> : (
              <div className="col">
                {lossAnalysis.reasons.map((reason) => (
                  <div key={reason.reason} className="col-tight" style={{ gap: 3, paddingBottom: 'var(--space-2)', borderBottom: '1px solid var(--surface-border)' }}>
                    <div className="between">
                      <span className="strong small">{reason.reason}</span>
                      <span className="row-tight xs">
                        <Badge tone="outline">{reason.count} deals</Badge>
                        <span className="tabular">{money(reason.value, undefined, { compact: true })}</span>
                      </span>
                    </div>
                    <span className="xs muted">
                      {reason.competitors.length ? `Lost to ${reason.competitors.join(', ')}. ` : ''}
                      {reason.lostMostAtStage ? `Usually dies at ${titleCase(reason.lostMostAtStage)}.` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Win / loss">
            <DonutChart
              size={130}
              centerValue={percent(lossAnalysis.winRate)}
              centerLabel="win rate"
              data={[
                { label: 'Won', value: lossAnalysis.wonCount, color: 'var(--success)' },
                { label: 'Lost', value: lossAnalysis.lostCount, color: 'var(--danger)' },
              ]}
            />
            <div className="col-tight small">
              <div className="between"><span className="muted">Won value</span><span className="tabular strong">{money(lossAnalysis.wonValue)}</span></div>
              <div className="between"><span className="muted">Lost value</span><span className="tabular">{money(lossAnalysis.lostValue)}</span></div>
            </div>
          </Card>
        </div>
      )}

      {tab === 'calllist' && (
        <Card title="Your call list" subtitle="Ranked by urgency, deal value and decay risk">
          {!callList.length ? <EmptyState title="Nothing queued" message="No overdue follow-ups or untouched leads." /> : (
            <div className="col-tight">
              {callList.map((entry) => (
                <div key={entry.leadId} className="between wrap gap-2" style={{ paddingBottom: 'var(--space-2)', borderBottom: '1px solid var(--surface-border)' }}>
                  <div className="row gap-2" style={{ minWidth: 0 }}>
                    <span className="avatar sm" style={{ background: 'var(--bg-active)', color: 'var(--text-secondary)' }}>{entry.rank}</span>
                    <div className="col-tight" style={{ gap: 1, minWidth: 0 }}>
                      <Link to={`/leads/${entry.leadId}`} className="small strong truncate">{entry.name}</Link>
                      <span className="xs muted">{entry.reasons.join(' · ')}</span>
                    </div>
                  </div>
                  <div className="row-tight">
                    {entry.value > 0 && <span className="tabular small">{money(entry.value, undefined, { compact: true })}</span>}
                    <button type="button" className="btn sm primary" onClick={() => window.salesos?.startCall({ leadId: entry.leadId })}>
                      <IconPhone size={13} /> Call
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </>
  );
}
