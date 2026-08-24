import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useRealtimeEvent } from '../lib/realtime.jsx';
import {
  PageHeader, Card, Badge, Tabs, Stat, Spinner, ErrorState, EmptyState,
  SearchBox, KeyValue, Meter, useToast, Drawer, TextField, TextArea, SelectField,
} from '../components/UI.jsx';
import SuggestionPanel from '../components/SuggestionPanel.jsx';
import { ScoreRing, BarChart } from '../components/Charts.jsx';
import {
  IconSparkles, IconWave, IconAlert, IconThumb, IconTask, IconMail, IconPlay,
  IconCheck, IconRefresh, IconClock, IconTarget, IconShield, IconPhone, IconRobot,
} from '../components/Icons.jsx';
import { duration, dateTime, titleCase, percent, money, date, clock, relative } from '../lib/format.js';

/**
 * The conversation record: transcript, AI summary, extracted intelligence,
 * suggested CRM updates, coaching scorecard, and the follow-up actions the AI
 * proposes. This is where "the call became CRM data" is made visible.
 */

function TranscriptView({ transcript, highlight }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState(null);
  const containerRef = useRef(null);

  const needle = query.trim().toLowerCase();
  const segments = transcript?.segments || [];

  const matchingIndexes = useMemo(() => {
    if (!needle) return new Set();
    return new Set(segments
      .map((segment, index) => (String(segment.text).toLowerCase().includes(needle) ? index : -1))
      .filter((index) => index >= 0));
  }, [needle, segments]);

  const renderText = (text) => {
    if (!needle) return text;
    const parts = String(text).split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return parts.map((part, index) => (part.toLowerCase() === needle ? <mark key={index}>{part}</mark> : part));
  };

  if (!transcript) {
    return <EmptyState icon={<IconWave size={20} />} title="No transcript" message="This call was not recorded, or the recording is still being processed." />;
  }

  return (
    <div className="col">
      <div className="row gap-2 wrap">
        <SearchBox value={query} onChange={setQuery} placeholder="Search within the transcript" />
        {needle && (
          <Badge tone={matchingIndexes.size ? 'accent' : 'outline'}>
            {matchingIndexes.size} match{matchingIndexes.size === 1 ? '' : 'es'}
          </Badge>
        )}
        <div className="right row-tight xs muted">
          <Badge tone="outline">{transcript.engine}</Badge>
          {transcript.confidence !== null && transcript.confidence !== undefined && (
            <span>{percent(transcript.confidence * 100)} confidence</span>
          )}
          {transcript.redactions?.length > 0 && (
            <Badge tone="warning" title="Sensitive data removed before storage">
              <IconShield size={10} /> {transcript.redactions.length} redacted
            </Badge>
          )}
        </div>
      </div>

      <div className="transcript" ref={containerRef}>
        {segments.map((segment, index) => (
          <div
            key={index}
            className={`transcript-line ${segment.role} ${matchingIndexes.has(index) ? 'highlight' : ''}`}
          >
            <span className="transcript-time">{clock(segment.start)}</span>
            <div className="transcript-bubble">
              <div className="transcript-speaker">{segment.speaker || titleCase(segment.role)}</div>
              <div>{renderText(segment.text)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FollowUpDrawer({ open, onClose, callId, onCreated }) {
  const toast = useToast();
  const [proposals, setProposals] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.post('/ai/follow-ups/propose', { callId })
      .then((result) => {
        setProposals(result.proposals || []);
        setSelected((result.proposals || []).map((_, index) => index));
      })
      .catch((error) => toast.error(error))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, callId]);

  const accept = async () => {
    setPending(true);
    try {
      const tasks = selected.map((index) => proposals[index]).filter(Boolean);
      const result = await api.post('/ai/follow-ups/accept', { tasks });
      toast.success(`${result.created} follow-up task${result.created === 1 ? '' : 's'} created`);
      onCreated?.();
      onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="AI suggested follow-ups"
      footer={(
        <button type="button" className="btn primary block" onClick={accept} disabled={pending || !selected.length}>
          {pending ? <Spinner /> : <IconTask />} Create {selected.length} task{selected.length === 1 ? '' : 's'}
        </button>
      )}
    >
      {loading && <Spinner label="Reading the conversation" />}
      {!loading && !proposals.length && (
        <EmptyState icon={<IconCheck size={18} />} title="No follow-ups needed" message="The AI did not find an outstanding commitment on this call." />
      )}
      <div className="col-tight">
        {proposals.map((proposal, index) => (
          <label key={index} className="card" style={{ padding: 'var(--space-3)', gap: 4, cursor: 'pointer' }}>
            <div className="row-tight">
              <input
                type="checkbox"
                checked={selected.includes(index)}
                onChange={(event) => setSelected((current) => (event.target.checked
                  ? [...current, index]
                  : current.filter((i) => i !== index)))}
              />
              <span className="strong small grow">{proposal.title}</span>
              <Badge tone={proposal.priority === 'urgent' ? 'danger' : proposal.priority === 'high' ? 'warning' : 'outline'}>
                {proposal.priority}
              </Badge>
            </div>
            <span className="xs muted">
              {titleCase(proposal.type)} · due {date(proposal.dueAt)}
            </span>
            {proposal.reason && <span className="xs secondary">{proposal.reason}</span>}
          </label>
        ))}
      </div>
    </Drawer>
  );
}

function EmailDrawer({ open, onClose, callId, leadId, leadEmail, onSent }) {
  const toast = useToast();
  const meta = useApi('/ai/status', undefined, { enabled: open });
  const [template, setTemplate] = useState('thank_you');
  const [draft, setDraft] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [instructions, setInstructions] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(null);
      setSubject('');
      setBody('');
    }
  }, [open]);

  const generate = async () => {
    setPending(true);
    try {
      const result = await api.post('/ai/email/generate', { template, callId, leadId, instructions: instructions || undefined });
      setDraft(result.draft);
      setSubject(result.draft.subject);
      setBody(result.draft.body);
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  const send = async () => {
    setPending(true);
    try {
      const created = await api.post('/emails', {
        leadId, callId, to: leadEmail, subject, body, template, generatedByAi: Boolean(draft),
      });
      await api.post(`/emails/${created.email.id}/send`);
      toast.success('Email sent and logged against this call');
      onSent?.();
      onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title="Generate follow-up email"
      footer={(
        <div className="row-tight">
          <button type="button" className="btn grow" onClick={generate} disabled={pending}>
            {pending ? <Spinner /> : <IconSparkles />} {draft ? 'Regenerate' : 'Generate'}
          </button>
          <button type="button" className="btn primary grow" onClick={send} disabled={pending || !subject || !body || !leadEmail}>
            <IconMail /> Send
          </button>
        </div>
      )}
    >
      <SelectField
        label="Email type"
        value={template}
        onChange={(event) => setTemplate(event.target.value)}
        options={(meta.data?.emailTemplates || []).map((t) => ({ value: t.key, label: t.label }))}
      />
      <TextArea
        label="Extra instructions (optional)"
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        rows={2}
        placeholder="Keep it to three sentences and offer Thursday or Friday."
      />
      {draft && (
        <>
          <TextField label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
          <TextArea label="Body" value={body} onChange={(event) => setBody(event.target.value)} rows={14} />
          {draft.talkingPoints?.length > 0 && (
            <Card title="Grounded in">
              <ul className="list-bullets small secondary">
                {draft.talkingPoints.map((point, index) => <li key={index}>{point}</li>)}
              </ul>
            </Card>
          )}
        </>
      )}
      {!leadEmail && <div className="banner warning small"><IconAlert /> No email address on this contact.</div>}
    </Drawer>
  );
}

export default function ConversationDetail() {
  const { callId } = useParams();
  const toast = useToast();
  const { can, isManager } = useAuth();
  const { askAi } = useOutletContext();
  const [tab, setTab] = useState('summary');
  const [showFollowUps, setShowFollowUps] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [reanalysing, setReanalysing] = useState(false);

  const { data, loading, error, refetch } = useApi(`/conversations/${callId}`);

  useRealtimeEvent('analysis.ready', (payload) => {
    if (payload?.callId === callId) refetch();
  });
  useRealtimeEvent('transcript.ready', (payload) => {
    if (payload?.callId === callId) refetch();
  });

  if (loading && !data) return <Spinner large label="Loading conversation" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return null;

  const { call, transcript, analysis, suggestions, coachingDimensions, emails, tasks } = data;

  if (!analysis && ['queued', 'processing'].includes(call.aiStatus)) {
    return (
      <>
        <PageHeader title="Conversation" subtitle={`${call.contactName || 'Unknown'} · ${dateTime(call.startedAt)}`} />
        <Card>
          <div className="row-tight"><Spinner /> <strong>AI is processing this call</strong></div>
          <p className="small secondary">
            The recording is being transcribed and analysed. This page updates itself when it is ready.
          </p>
        </Card>
      </>
    );
  }

  const reanalyse = async () => {
    setReanalysing(true);
    try {
      await api.post(`/conversations/${callId}/reanalyse`);
      toast.success('Re-analysed with the current model and prompt');
      refetch();
    } catch (caught) {
      toast.error(caught);
    } finally {
      setReanalysing(false);
    }
  };

  const scorecard = analysis?.scorecard || {};
  const coaching = analysis?.coaching || {};
  const extraction = analysis?.extraction || {};

  const tabs = [
    { key: 'summary', label: 'Summary' },
    { key: 'transcript', label: 'Transcript', count: transcript?.segments?.length },
    { key: 'intelligence', label: 'Extracted data' },
    { key: 'coaching', label: 'Coaching' },
  ];

  return (
    <>
      <PageHeader
        title={call.contactName || 'Conversation'}
        subtitle={[
          call.companyName,
          dateTime(call.startedAt),
          call.durationLabel,
          titleCase(call.direction),
          isManager && call.agentName ? call.agentName : null,
        ].filter(Boolean).join(' · ')}
        actions={(
          <>
            {call.leadId && <Link to={`/leads/${call.leadId}`} className="btn">Open CRM record</Link>}
            <button type="button" className="btn" onClick={() => setShowEmail(true)}>
              <IconMail /> Follow-up email
            </button>
            <button type="button" className="btn" onClick={() => setShowFollowUps(true)}>
              <IconTask /> Follow-up tasks
            </button>
            {call.hasRecording && can('call:recording:listen') && (
              <a className="btn" href={`/api/v1/calls/${callId}/recording`} target="_blank" rel="noreferrer">
                <IconPlay /> Recording
              </a>
            )}
            {can('ai:analyze') && (
              <button type="button" className="btn ghost icon" onClick={reanalyse} disabled={reanalysing} title="Re-run analysis">
                {reanalysing ? <Spinner /> : <IconRefresh />}
              </button>
            )}
          </>
        )}
      >
        <div className="row-tight wrap mt-2">
          {analysis?.sentiment && <Badge tone={analysis.sentiment}>{analysis.sentiment} sentiment</Badge>}
          {call.outcome && <Badge tone="outline">{titleCase(call.outcome)}</Badge>}
          {call.hasRecording && <Badge tone="outline">recorded</Badge>}
          {call.recordingConsent === 'granted' && <Badge tone="success">consent captured</Badge>}
          {call.dealName && <Badge tone="purple">{call.dealName} · {titleCase(call.dealStage || '')}</Badge>}
          {analysis?.provider && (
            <Badge tone="outline" title={analysis.model}>
              {analysis.provider === 'anthropic' ? analysis.model : 'built-in engine'}
            </Badge>
          )}
        </div>
      </PageHeader>

      {suggestions?.length > 0 && (
        <SuggestionPanel
          suggestions={suggestions}
          onChange={refetch}
          sourceSummary={analysis?.summary}
        />
      )}

      <div className="grid grid-4">
        <Stat label="Call score" value={scorecard.overall ?? '--'} accent={scorecard.overall >= 70 ? 'var(--success)' : scorecard.overall >= 55 ? 'var(--warning)' : 'var(--danger)'} icon={<IconTarget />} />
        <Stat
          label="Talk ratio"
          value={analysis?.talkRatio ? percent(analysis.talkRatio * 100) : '--'}
          meta="agent share of the conversation"
          accent={analysis?.talkRatio > 0.6 ? 'var(--warning)' : undefined}
          icon={<IconThumb />}
        />
        <Stat label="Objections" value={(analysis?.objections || []).length} meta={`${(analysis?.objections || []).filter((o) => !o.handled).length} unresolved`} icon={<IconAlert />} />
        <Stat label="Buying signals" value={(analysis?.buyingSignals || []).length} icon={<IconSparkles />} />
      </div>

      <div className="pill-tabs" style={{ alignSelf: 'flex-start' }}>
        {tabs.map((entry) => (
          <button key={entry.key} type="button" className={tab === entry.key ? 'active' : ''} onClick={() => setTab(entry.key)}>
            {entry.label}{entry.count ? <span className="muted"> {entry.count}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
        <div className="grid grid-main">
          <div className="col">
            <Card title="AI summary" actions={<Badge tone="accent"><IconRobot size={11} /> generated</Badge>}>
              <p style={{ margin: 0, lineHeight: 1.65 }}>{analysis?.summary || 'No summary available.'}</p>
              {(analysis?.keyPoints || []).length > 0 && (
                <>
                  <hr className="divider" />
                  <span className="uppercase muted">Key points</span>
                  <ul className="list-bullets small">
                    {analysis.keyPoints.map((point, index) => <li key={index}>{point}</li>)}
                  </ul>
                </>
              )}
            </Card>

            {(analysis?.objections || []).length > 0 && (
              <Card title="Objections">
                <div className="col-tight">
                  {analysis.objections.map((objection, index) => (
                    <div key={index} className="col-tight" style={{ gap: 3 }}>
                      <div className="row-tight wrap">
                        <Badge tone={objection.severity === 'high' ? 'danger' : objection.severity === 'medium' ? 'warning' : 'outline'}>
                          {titleCase(objection.category)}
                        </Badge>
                        <Badge tone={objection.handled ? 'success' : 'danger'}>
                          {objection.handled ? 'handled on the call' : 'still open'}
                        </Badge>
                      </div>
                      <p className="small" style={{ margin: 0 }}>{objection.text}</p>
                      {objection.evidence && objection.evidence !== objection.text && (
                        <blockquote className="suggestion-evidence">“{objection.evidence}”</blockquote>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {(analysis?.buyingSignals || []).length > 0 && (
              <Card title="Buying signals">
                <div className="col-tight">
                  {analysis.buyingSignals.map((signal, index) => (
                    <div key={index} className="col-tight" style={{ gap: 2 }}>
                      <div className="row-tight">
                        <Badge tone={signal.strength === 'strong' ? 'success' : signal.strength === 'moderate' ? 'warning' : 'outline'}>
                          {signal.strength || 'signal'}
                        </Badge>
                        <span className="small strong">{signal.signal}</span>
                      </div>
                      {signal.evidence && <blockquote className="suggestion-evidence">“{signal.evidence}”</blockquote>}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {(analysis?.questions || []).length > 0 && (
              <Card title="Customer questions">
                <ul className="list-plain">
                  {analysis.questions.map((question, index) => (
                    <li key={index} className="row-tight">
                      <Badge tone={question.answered ? 'success' : 'warning'}>{question.answered ? 'answered' : 'open'}</Badge>
                      <span className="small">{question.question}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>

          <div className="col">
            {(analysis?.nextSteps || []).length > 0 && (
              <Card title="Next steps">
                <ul className="list-bullets small">
                  {analysis.nextSteps.map((step, index) => <li key={index}>{step}</li>)}
                </ul>
              </Card>
            )}

            {(analysis?.commitments || []).length > 0 && (
              <Card title="Commitments made">
                <div className="col-tight">
                  {analysis.commitments.map((commitment, index) => (
                    <div key={index} className="col-tight" style={{ gap: 1 }}>
                      <div className="row-tight">
                        <Badge tone={commitment.party === 'agent' ? 'accent' : 'purple'}>{titleCase(commitment.party)}</Badge>
                        {commitment.due_date && <span className="xs muted">{date(commitment.due_date)}</span>}
                      </div>
                      <span className="small">{commitment.text}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {(analysis?.actionItems || []).length > 0 && (
              <Card
                title="Action items"
                actions={<button type="button" className="btn sm" onClick={() => setShowFollowUps(true)}>Create tasks</button>}
              >
                <div className="col-tight">
                  {analysis.actionItems.map((item, index) => (
                    <div key={index} className="between">
                      <span className="small grow">{item.text}</span>
                      <div className="row-tight">
                        <Badge tone={item.priority === 'urgent' ? 'danger' : 'outline'}>{item.priority || 'medium'}</Badge>
                        {item.due_date && <span className="xs muted nowrap">{date(item.due_date)}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {(analysis?.risks || []).length > 0 && (
              <Card title="Risks">
                <ul className="list-bullets small">
                  {analysis.risks.map((risk, index) => <li key={index}>{risk}</li>)}
                </ul>
              </Card>
            )}

            {tasks?.length > 0 && (
              <Card title="Tasks from this call">
                <div className="col-tight">
                  {tasks.map((task) => (
                    <div key={task.id} className="between small">
                      <span className="truncate">{task.title}</span>
                      <Badge tone={task.status === 'done' ? 'success' : 'outline'}>{task.status}</Badge>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {emails?.length > 0 && (
              <Card title="Emails from this call">
                <div className="col-tight">
                  {emails.map((email) => (
                    <div key={email.id} className="between small">
                      <span className="truncate">{email.subject}</span>
                      <Badge tone={email.status === 'sent' ? 'success' : 'outline'}>{email.status}</Badge>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <button type="button" className="btn subtle" onClick={() => askAi(`Summarise the conversation with ${call.contactName} and tell me what to do next`)}>
              <IconSparkles /> Ask AI about this call
            </button>
          </div>
        </div>
      )}

      {tab === 'transcript' && (
        <Card title="Transcript" subtitle={transcript ? `${transcript.segments.length} segments · ${duration(transcript.durationSeconds)}` : undefined}>
          <TranscriptView transcript={transcript} />
        </Card>
      )}

      {tab === 'intelligence' && (
        <div className="grid grid-2">
          <Card title="Extracted CRM data" subtitle="What the AI found in the conversation">
            <KeyValue items={[
              { label: 'Customer interest', value: extraction.customer_interest ? titleCase(extraction.customer_interest) : null },
              { label: 'Product discussed', value: extraction.product_discussed },
              { label: 'Budget', value: extraction.budget ? money(extraction.budget) : null },
              { label: 'Expected value', value: extraction.expected_value ? money(extraction.expected_value) : null },
              { label: 'Timeline', value: extraction.timeline },
              { label: 'Decision maker', value: extraction.decision_maker },
              { label: 'Deal stage', value: extraction.deal_stage ? titleCase(extraction.deal_stage) : null },
              { label: 'Lead temperature', value: extraction.lead_temperature ? titleCase(extraction.lead_temperature) : null },
              { label: 'Follow-up date', value: extraction.follow_up_date ? date(extraction.follow_up_date) : null },
              { label: 'Next action', value: extraction.next_action },
              { label: 'Company size', value: extraction.company_size },
              { label: 'Lost reason', value: extraction.lost_reason },
            ]}
            />
            {extraction.budget_evidence && (
              <blockquote className="suggestion-evidence">“{extraction.budget_evidence}”</blockquote>
            )}
          </Card>

          <div className="col">
            {(extraction.pain_points || []).length > 0 && (
              <Card title="Pain points">
                <ul className="list-bullets small">
                  {extraction.pain_points.map((point, index) => <li key={index}>{point}</li>)}
                </ul>
              </Card>
            )}
            {(extraction.requirements || []).length > 0 && (
              <Card title="Requirements">
                <ul className="list-bullets small">
                  {extraction.requirements.map((requirement, index) => <li key={index}>{requirement}</li>)}
                </ul>
              </Card>
            )}
            {(analysis?.competitors || []).length > 0 && (
              <Card title="Competitors mentioned">
                <div className="tag-list">
                  {analysis.competitors.map((competitor) => <span key={competitor} className="chip">{competitor}</span>)}
                </div>
              </Card>
            )}
            {(analysis?.topics || []).length > 0 && (
              <Card title="Topics">
                <div className="tag-list">
                  {analysis.topics.map((topic) => <span key={topic} className="chip">{titleCase(topic)}</span>)}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'coaching' && (
        <div className="grid grid-main">
          <Card title="Call scorecard" subtitle="Scored against eight dimensions of a good sales conversation">
            <div className="row gap-5 wrap">
              <ScoreRing score={scorecard.overall || 0} size={90} thickness={8} label="Overall" />
              <div className="grow col-tight">
                {coachingDimensions.map((dimension) => (
                  <Meter
                    key={dimension.key}
                    label={dimension.label}
                    value={scorecard[dimension.key] ?? 0}
                    tone={(scorecard[dimension.key] ?? 0) >= 70 ? 'success' : (scorecard[dimension.key] ?? 0) >= 50 ? 'warning' : 'danger'}
                  />
                ))}
              </div>
            </div>
          </Card>

          <div className="col">
            {coaching.recommendation && (
              <Card title="Coaching recommendation">
                <p className="small" style={{ margin: 0 }}>{coaching.recommendation}</p>
              </Card>
            )}
            {(coaching.strengths || []).length > 0 && (
              <Card title="What worked">
                <ul className="list-bullets small">
                  {coaching.strengths.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </Card>
            )}
            {(coaching.improvements || []).length > 0 && (
              <Card title="What to change">
                <ul className="list-bullets small">
                  {coaching.improvements.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </Card>
            )}
            {(coaching.missed_opportunities || []).length > 0 && (
              <Card title="Missed opportunities">
                <ul className="list-bullets small">
                  {coaching.missed_opportunities.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}

      <FollowUpDrawer open={showFollowUps} onClose={() => setShowFollowUps(false)} callId={callId} onCreated={refetch} />
      <EmailDrawer
        open={showEmail}
        onClose={() => setShowEmail(false)}
        callId={callId}
        leadId={call.leadId}
        leadEmail={call.email}
        onSent={refetch}
      />
    </>
  );
}
