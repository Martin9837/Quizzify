import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useRealtimeEvent } from '../lib/realtime.jsx';
import {
  PageHeader, Card, Badge, Stat, Spinner, ErrorState, EmptyState, Tabs, Switch, useToast,
} from '../components/UI.jsx';
import SuggestionPanel from '../components/SuggestionPanel.jsx';
import api from '../lib/api.js';
import { IconRobot, IconSparkles, IconShield, IconCheck, IconClock } from '../components/Icons.jsx';
import { relative, dateTime, number, titleCase } from '../lib/format.js';

/**
 * The AI approval queue.
 *
 * This screen is the product's honesty mechanism: everything the AI wants to
 * change to the CRM is here, grouped by the conversation that produced it, with
 * the evidence attached. Administrators can also see and change the policy that
 * decides what needs approval at all.
 */
export default function Approvals() {
  const toast = useToast();
  const { settings, isAdmin, updateSettings } = useAuth();
  const [status, setStatus] = useState('pending');
  const { data, loading, error, refetch } = useApi('/ai/suggestions', { status, limit: 200 });

  useRealtimeEvent('ai.suggestions.ready', () => refetch());
  useRealtimeEvent('analysis.ready', () => refetch());

  const batches = data?.batches || [];
  const suggestions = data?.suggestions || [];
  const sensitive = suggestions.filter((entry) => entry.sensitivity === 'sensitive').length;
  const policy = settings?.crmApproval || {};

  const setPolicy = async (patch) => {
    try {
      const result = await api.patch('/admin/settings', { settings: { crmApproval: patch } });
      updateSettings(result.settings);
      toast.success('Approval policy updated');
    } catch (caught) {
      toast.error(caught);
    }
  };

  return (
    <>
      <PageHeader
        title="AI approvals"
        subtitle="CRM changes the AI extracted from conversations, waiting for a human decision"
      />

      <div className="grid grid-4">
        <Stat label="Pending" value={number(status === 'pending' ? suggestions.length : 0)} icon={<IconClock />} />
        <Stat label="Batches" value={number(batches.length)} meta="one per conversation" icon={<IconRobot />} />
        <Stat label="Sensitive" value={number(sensitive)} meta="value, stage or close date" accent={sensitive ? 'var(--warning)' : undefined} icon={<IconShield />} />
        <Stat
          label="Policy"
          value={policy.mode === 'auto' ? 'Automatic' : 'Human approval'}
          meta={policy.mode === 'auto' ? `above ${Math.round((policy.autoApplyConfidenceThreshold || 0.85) * 100)}% confidence` : 'nothing applies without review'}
          icon={<IconSparkles />}
        />
      </div>

      {isAdmin && (
        <Card title="Approval policy" subtitle="How much autonomy the AI has over your CRM">
          <div className="grid grid-2">
            <div className="col-tight">
              <div className="pill-tabs" style={{ alignSelf: 'flex-start' }}>
                <button type="button" className={policy.mode !== 'auto' ? 'active' : ''} onClick={() => setPolicy({ mode: 'suggest' })}>
                  AI suggests, human approves
                </button>
                <button type="button" className={policy.mode === 'auto' ? 'active' : ''} onClick={() => setPolicy({ mode: 'auto' })}>
                  Apply automatically
                </button>
              </div>
              <span className="xs muted">
                {policy.mode === 'auto'
                  ? 'High-confidence, non-sensitive changes are applied the moment analysis completes. Everything is still audited.'
                  : 'Nothing reaches the CRM until someone approves it here.'}
              </span>
            </div>
            <div className="col-tight">
              <Switch
                checked={policy.alwaysReviewSensitive !== false}
                onChange={(value) => setPolicy({ alwaysReviewSensitive: value })}
                label="Always review sensitive fields (deal value, stage, close date)"
              />
              <Switch
                checked={Boolean(policy.autoCreateTasks)}
                onChange={(value) => setPolicy({ autoCreateTasks: value })}
                label="Create AI follow-up tasks without asking"
              />
            </div>
          </div>
        </Card>
      )}

      <Tabs
        active={status}
        onChange={setStatus}
        tabs={[
          { key: 'pending', label: 'Pending' },
          { key: 'approved', label: 'Approved' },
          { key: 'auto_applied', label: 'Auto-applied' },
          { key: 'rejected', label: 'Rejected' },
          { key: 'all', label: 'Everything' },
        ]}
      />

      {loading && !data && <Spinner large label="Loading suggestions" />}
      {error && <ErrorState error={error} onRetry={refetch} />}

      {!loading && !batches.length && (
        <EmptyState
          icon={<IconCheck size={22} />}
          title={status === 'pending' ? 'Nothing waiting for you' : 'No suggestions here'}
          message={status === 'pending'
            ? 'Every AI-suggested CRM change has been decided. New ones appear here as calls are analysed.'
            : 'Try another filter.'}
        />
      )}

      <div className="col">
        {batches.map((batch) => (
          <Card
            key={batch.batchId}
            title={batch.source?.contactName
              ? `${batch.source.contactName}${batch.source.companyName ? ` · ${batch.source.companyName}` : ''}`
              : `${titleCase(batch.sourceType)} update`}
            subtitle={batch.source?.startedAt ? `Call on ${dateTime(batch.source.startedAt)}` : relative(batch.createdAt)}
            actions={batch.sourceType === 'call' && batch.sourceId && (
              <Link to={`/conversations/${batch.sourceId}`} className="btn sm ghost">Open conversation</Link>
            )}
          >
            {batch.source?.summary && <p className="small secondary" style={{ margin: 0 }}>{batch.source.summary}</p>}
            <SuggestionPanel
              compact
              title={`${batch.suggestions.length} suggested change${batch.suggestions.length === 1 ? '' : 's'}`}
              suggestions={batch.suggestions}
              onChange={refetch}
            />
          </Card>
        ))}
      </div>
    </>
  );
}
