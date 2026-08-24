import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useRealtimeEvent } from '../lib/realtime.jsx';
import {
  PageHeader, Card, Badge, Stat, SearchBox, SelectField, Spinner,
  ErrorState, EmptyState, Tabs,
} from '../components/UI.jsx';
import { ScoreRing } from '../components/Charts.jsx';
import { IconWave, IconSparkles, IconAlert, IconThumb, IconClock, IconTarget } from '../components/Icons.jsx';
import { duration, relative, titleCase, number, percent } from '../lib/format.js';

/**
 * Conversation feed: every analysed call, with the intelligence surfaced on the
 * card so a manager or agent can scan for what matters without opening each one.
 */

const OBJECTION_FILTERS = ['pricing', 'budget', 'timing', 'authority', 'competitor', 'features', 'security', 'contract_terms', 'status_quo'];

export default function Conversations() {
  const { isManager } = useAuth();
  const [sentiment, setSentiment] = useState('');
  const [objection, setObjection] = useState('');
  const [minScore, setMinScore] = useState('');

  const { data, loading, error, refetch } = useApi('/conversations', {
    limit: 40,
    sentiment: sentiment || undefined,
    objection: objection || undefined,
    minScore: minScore || undefined,
  });

  useRealtimeEvent('analysis.ready', () => refetch());

  const conversations = data?.conversations || [];
  const avgScore = conversations.length
    ? Math.round(conversations.reduce((sum, c) => sum + (c.analysis?.scorecard?.overall || 0), 0) / conversations.length)
    : 0;
  const avgTalkRatio = conversations.length
    ? conversations.reduce((sum, c) => sum + (c.analysis?.talkRatio || 0), 0) / conversations.length
    : 0;
  const withObjections = conversations.filter((c) => (c.analysis?.objections || []).length > 0).length;

  return (
    <>
      <PageHeader
        title="Conversations"
        subtitle={data ? `${number(data.total)} analysed calls` : 'Loading'}
      />

      <div className="grid grid-4">
        <Stat label="Analysed calls" value={number(data?.total || 0)} icon={<IconWave />} />
        <Stat
          label="Average call score"
          value={avgScore || '--'}
          meta="0-100 across eight dimensions"
          accent={avgScore >= 70 ? 'var(--success)' : avgScore >= 55 ? 'var(--warning)' : 'var(--danger)'}
          icon={<IconTarget />}
        />
        <Stat
          label="Average talk ratio"
          value={avgTalkRatio ? percent(avgTalkRatio * 100) : '--'}
          meta="Aim for 40-50% agent"
          accent={avgTalkRatio > 0.6 ? 'var(--warning)' : undefined}
          icon={<IconThumb />}
        />
        <Stat label="Calls with objections" value={number(withObjections)} icon={<IconAlert />} />
      </div>

      <Card flush>
        <div className="row gap-2 wrap card-body-pad">
          <div className="pill-tabs">
            {['', 'positive', 'neutral', 'mixed', 'negative'].map((value) => (
              <button
                key={value || 'all'}
                type="button"
                className={sentiment === value ? 'active' : ''}
                onClick={() => setSentiment(value)}
              >
                {value ? titleCase(value) : 'All sentiment'}
              </button>
            ))}
          </div>
          <select className="select" style={{ maxWidth: 190 }} value={objection} onChange={(event) => setObjection(event.target.value)} aria-label="Filter by objection">
            <option value="">Any objection</option>
            {OBJECTION_FILTERS.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
          </select>
          <select className="select" style={{ maxWidth: 170 }} value={minScore} onChange={(event) => setMinScore(event.target.value)} aria-label="Minimum call score">
            <option value="">Any score</option>
            <option value="80">80 and above</option>
            <option value="65">65 and above</option>
            <option value="50">50 and above</option>
          </select>
        </div>
      </Card>

      {loading && !data && <Spinner large label="Loading conversations" />}
      {error && <ErrorState error={error} onRetry={refetch} />}

      {!loading && conversations.length === 0 && (
        <EmptyState
          icon={<IconWave size={22} />}
          title="No analysed conversations yet"
          message="Record a call and the AI pipeline will transcribe, summarise and extract CRM data from it."
        />
      )}

      <div className="col">
        {conversations.map((conversation) => {
          const analysis = conversation.analysis || {};
          const objections = analysis.objections || [];
          const signals = analysis.buyingSignals || [];
          return (
            <Card key={conversation.callId} className="hover">
              <div className="between wrap gap-2">
                <div className="row gap-4" style={{ alignItems: 'flex-start' }}>
                  <ScoreRing score={analysis.scorecard?.overall || 0} size={54} thickness={5} label="Call score" />
                  <div className="col-tight" style={{ gap: 2, minWidth: 0 }}>
                    <div className="row-tight wrap">
                      <Link to={`/conversations/${conversation.callId}`} className="strong">
                        {conversation.contactName || 'Unknown contact'}
                      </Link>
                      {conversation.companyName && <span className="muted small">{conversation.companyName}</span>}
                      {analysis.sentiment && <Badge tone={analysis.sentiment}>{analysis.sentiment}</Badge>}
                      {conversation.pendingSuggestions > 0 && (
                        <Badge tone="accent"><IconSparkles size={10} /> {conversation.pendingSuggestions} updates to review</Badge>
                      )}
                    </div>
                    <span className="xs muted">
                      {relative(conversation.startedAt)} · {conversation.durationLabel} · {titleCase(conversation.direction)}
                      {isManager && conversation.agentName ? ` · ${conversation.agentName}` : ''}
                      {analysis.talkRatio ? ` · ${percent(analysis.talkRatio * 100)} agent talk` : ''}
                    </span>
                  </div>
                </div>
                <Link to={`/conversations/${conversation.callId}`} className="btn sm">Open</Link>
              </div>

              {analysis.summary && <p className="secondary small" style={{ margin: 0 }}>{analysis.summary}</p>}

              <div className="grid grid-3">
                {objections.length > 0 && (
                  <div className="col-tight" style={{ gap: 3 }}>
                    <span className="uppercase muted">Objections</span>
                    {objections.slice(0, 3).map((objection2, index) => (
                      <span key={index} className="small row-tight">
                        <Badge tone={objection2.handled ? 'outline' : 'danger'}>{titleCase(objection2.category)}</Badge>
                        <span className="truncate">{objection2.text}</span>
                      </span>
                    ))}
                  </div>
                )}
                {signals.length > 0 && (
                  <div className="col-tight" style={{ gap: 3 }}>
                    <span className="uppercase muted">Buying signals</span>
                    {signals.slice(0, 3).map((signal, index) => (
                      <span key={index} className="small row-tight">
                        <Badge tone={signal.strength === 'strong' ? 'success' : 'outline'}>{signal.strength || 'signal'}</Badge>
                        <span className="truncate">{signal.signal}</span>
                      </span>
                    ))}
                  </div>
                )}
                {(analysis.nextSteps || []).length > 0 && (
                  <div className="col-tight" style={{ gap: 3 }}>
                    <span className="uppercase muted">Next steps</span>
                    {analysis.nextSteps.slice(0, 3).map((step, index) => (
                      <span key={index} className="small truncate">{step}</span>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
