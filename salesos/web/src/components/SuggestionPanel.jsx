import { useState } from 'react';
import api from '../lib/api.js';
import { useToast } from './UI.jsx';
import { Badge, Spinner } from './UI.jsx';
import { date, money, titleCase, dateTime } from '../lib/format.js';
import { IconCheck, IconX, IconEdit, IconSparkles, IconShield } from './Icons.jsx';

/**
 * AI Suggested CRM Updates.
 *
 * The heart of the product's promise: the agent sees exactly what the AI wants
 * to change, the evidence behind it, and how confident it is -- then approves,
 * edits or rejects. Sensitive fields are visually separated because they carry a
 * different decision weight (money, stage, dates), and nothing is applied here
 * without an explicit action.
 */

function formatValue(value, valueType) {
  if (value === null || value === undefined || value === '') return <span className="muted">not set</span>;
  if (Array.isArray(value)) return value.length ? value.join(', ') : <span className="muted">empty</span>;
  if (valueType === 'date') return date(value);
  if (valueType === 'number') {
    // Currency-shaped fields read better as money; plain counts as numbers.
    return Number(value) >= 1000 ? money(value) : String(value);
  }
  return titleCase(String(value));
}

function ConfidenceBar({ value }) {
  const pct = Math.round((Number(value) || 0) * 100);
  const tone = pct >= 80 ? 'var(--success)' : pct >= 60 ? 'var(--warning)' : 'var(--danger)';
  return (
    <span className="row-tight xs muted" title={`Model confidence: ${pct}%`}>
      <span className="confidence-bar"><span style={{ width: `${pct}%`, background: tone }} /></span>
      {pct}%
    </span>
  );
}

function SuggestionRow({ suggestion, onDecide, pendingId }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    Array.isArray(suggestion.suggestedValue) ? suggestion.suggestedValue.join(', ') : suggestion.suggestedValue ?? '',
  );
  const busy = pendingId === suggestion.id;
  const decided = suggestion.status !== 'pending';

  return (
    <div className={`suggestion ${suggestion.sensitivity === 'sensitive' ? 'sensitive' : ''}`}>
      <div className="between">
        <div className="row-tight">
          <strong className="small">{suggestion.label || titleCase(suggestion.field)}</strong>
          <Badge tone="outline">{suggestion.entityType}</Badge>
          {suggestion.sensitivity === 'sensitive' && (
            <Badge tone="warning" title="Sensitive field: always needs a human decision"><IconShield size={11} /> Needs review</Badge>
          )}
        </div>
        <ConfidenceBar value={suggestion.confidence} />
      </div>

      <div className="suggestion-change">
        <span className="suggestion-old">{formatValue(suggestion.currentValue, suggestion.valueType)}</span>
        <span className="muted">→</span>
        {editing ? (
          <input
            className="input"
            style={{ maxWidth: 260 }}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            type={suggestion.valueType === 'date' ? 'date' : suggestion.valueType === 'number' ? 'number' : 'text'}
            aria-label={`Edited value for ${suggestion.label}`}
          />
        ) : (
          <span className="suggestion-new">{formatValue(suggestion.appliedValue ?? suggestion.suggestedValue, suggestion.valueType)}</span>
        )}
      </div>

      {suggestion.rationale && <p className="small secondary" style={{ margin: 0 }}>{suggestion.rationale}</p>}
      {suggestion.evidence?.length > 0 && (
        <blockquote className="suggestion-evidence">“{suggestion.evidence[0]}”</blockquote>
      )}

      {decided ? (
        <div className="row-tight xs muted">
          <Badge tone={suggestion.status === 'rejected' ? 'danger' : suggestion.status === 'auto_applied' ? 'accent' : 'success'}>
            {titleCase(suggestion.status)}
          </Badge>
          {suggestion.decidedAt && <span>{dateTime(suggestion.decidedAt)}</span>}
        </div>
      ) : (
        <div className="row-tight">
          {editing ? (
            <>
              <button type="button" className="btn primary sm" disabled={busy} onClick={() => onDecide(suggestion, 'edit', draft)}>
                {busy ? <Spinner /> : <IconCheck />} Apply edit
              </button>
              <button type="button" className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="btn primary sm" disabled={busy} onClick={() => onDecide(suggestion, 'approve')}>
                {busy ? <Spinner /> : <IconCheck />} Approve
              </button>
              <button type="button" className="btn sm" onClick={() => setEditing(true)}><IconEdit /> Edit</button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => onDecide(suggestion, 'reject')}>
                <IconX /> Reject
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function SuggestionPanel({ suggestions = [], onChange, title = 'AI suggested CRM updates', compact = false, sourceSummary }) {
  const toast = useToast();
  const [pendingId, setPendingId] = useState(null);
  const [batchPending, setBatchPending] = useState(false);

  const pending = suggestions.filter((suggestion) => suggestion.status === 'pending');
  const resolved = suggestions.filter((suggestion) => suggestion.status !== 'pending');

  const decide = async (suggestion, action, value) => {
    setPendingId(suggestion.id);
    try {
      await api.post(`/ai/suggestions/${suggestion.id}/decide`, { action, value });
      toast.success(action === 'reject' ? 'Suggestion dismissed' : `${suggestion.label} updated`);
      onChange?.();
    } catch (error) {
      toast.error(error);
    } finally {
      setPendingId(null);
    }
  };

  const decideBatch = async (action) => {
    const batchId = pending[0]?.batchId;
    if (!batchId) return;
    setBatchPending(true);
    try {
      const result = await api.post(`/ai/suggestions/batch/${batchId}/decide`, { action });
      toast.success(action === 'approve'
        ? `${result.decided} CRM ${result.decided === 1 ? 'field' : 'fields'} updated`
        : `${result.decided} suggestions dismissed`);
      onChange?.();
    } catch (error) {
      toast.error(error);
    } finally {
      setBatchPending(false);
    }
  };

  if (!suggestions.length) return null;

  const sensitiveCount = pending.filter((s) => s.sensitivity === 'sensitive').length;

  return (
    <section className={compact ? 'col' : 'card'}>
      <header className="between">
        <div className="row-tight">
          <span style={{ color: 'var(--accent)' }}><IconSparkles /></span>
          <div className="col-tight" style={{ gap: 0 }}>
            <strong>{title}</strong>
            {sourceSummary && <span className="xs muted truncate" style={{ maxWidth: 420 }}>{sourceSummary}</span>}
          </div>
          {pending.length > 0 && <Badge tone="accent">{pending.length} pending</Badge>}
        </div>
        {pending.length > 1 && (
          <div className="row-tight">
            <button type="button" className="btn primary sm" disabled={batchPending} onClick={() => decideBatch('approve')}>
              {batchPending ? <Spinner /> : <IconCheck />} Approve all
            </button>
            <button type="button" className="btn sm ghost" disabled={batchPending} onClick={() => decideBatch('reject')}>
              Reject all
            </button>
          </div>
        )}
      </header>

      {sensitiveCount > 0 && (
        <div className="banner warning small">
          <IconShield />
          <span>
            {sensitiveCount} {sensitiveCount === 1 ? 'change affects' : 'changes affect'} deal value, stage or close date.
            Your organisation requires a human decision on those.
          </span>
        </div>
      )}

      <div className="col-tight">
        {pending.map((suggestion) => (
          <SuggestionRow key={suggestion.id} suggestion={suggestion} onDecide={decide} pendingId={pendingId} />
        ))}
      </div>

      {resolved.length > 0 && (
        <details>
          <summary className="small muted pointer">{resolved.length} already decided</summary>
          <div className="col-tight mt-2">
            {resolved.map((suggestion) => (
              <SuggestionRow key={suggestion.id} suggestion={suggestion} onDecide={decide} pendingId={pendingId} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
