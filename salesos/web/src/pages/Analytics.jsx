import { useMemo, useState } from 'react';
import api from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader, Card, Badge, Stat, Spinner, ErrorState, EmptyState, Tabs, DataTable, useToast,
} from '../components/UI.jsx';
import { FunnelChart, BarChart, LineChart, DonutChart } from '../components/Charts.jsx';
import { IconChart, IconDownload, IconFile, IconTrend, IconClock, IconTarget } from '../components/Icons.jsx';
import { money, number, percent, titleCase, date } from '../lib/format.js';

/**
 * Analytics and reports. Every report is a server-side query so the numbers in
 * an export always match the numbers on screen, and CSV/print exports are driven
 * by the same endpoint.
 */

const PERIODS = [
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
  { key: '365', label: '12 months' },
];

function ReportTable({ rows }) {
  if (!rows?.length) return <EmptyState title="No data for this period" />;
  const columns = Object.keys(rows[0]).map((key) => ({
    key,
    label: titleCase(key),
    numeric: typeof rows[0][key] === 'number',
    render: (row) => {
      const value = row[key];
      if (value === null || value === undefined) return <span className="muted">--</span>;
      if (typeof value === 'number') {
        return /revenue|value|amount|quota|pipeline/i.test(key)
          ? <span className="tabular">{money(value)}</span>
          : <span className="tabular">{number(value)}</span>;
      }
      return String(value);
    },
  }));
  return <DataTable columns={columns} rows={rows} rowKey={(row, index) => JSON.stringify(row).slice(0, 40) + index} />;
}

export default function Analytics() {
  const toast = useToast();
  const { isManager, can } = useAuth();
  const [days, setDays] = useState('30');
  const [report, setReport] = useState('sales_performance');

  // Memoised: a timestamp recomputed on every render changes the query key on
  // every render, which turns a data hook into an infinite refetch loop.
  const since = useMemo(() => new Date(Date.now() - Number(days) * 86400000).toISOString(), [days]);
  const funnel = useApi('/analytics/funnel', { since });
  const catalogue = useApi('/analytics/reports');
  const reportData = useApi(`/analytics/reports/${report}`, { days, since });
  const team = useApi('/analytics/team', { since }, { enabled: isManager });
  const revenue = useApi('/analytics/reports/revenue', { days: 365 });
  const aiUsage = useApi('/ai/usage', { since });

  const exportCsv = async () => {
    try {
      await api.download(`/analytics/reports/${report}`, { days, format: 'csv' }, `${report}-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success('Export downloaded');
    } catch (error) {
      toast.error(error);
    }
  };

  const revenueRows = revenue.data?.rows || [];

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Sales performance, conversion, velocity and AI conversation insight"
        actions={(
          <>
            <div className="pill-tabs">
              {PERIODS.map((period) => (
                <button key={period.key} type="button" className={days === period.key ? 'active' : ''} onClick={() => setDays(period.key)}>
                  {period.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn" onClick={() => window.print()}><IconFile /> Print / PDF</button>
            {can('report:export') && <button type="button" className="btn primary" onClick={exportCsv}><IconDownload /> Export CSV</button>}
          </>
        )}
      />

      {isManager && team.data && (
        <div className="grid grid-4">
          <Stat label="Revenue closed" value={money(team.data.totals.revenue, undefined, { compact: true })} meta={`${team.data.totals.dealsWon} deals`} icon={<IconTrend />} />
          <Stat label="Weighted forecast" value={money(team.data.totals.weightedForecast, undefined, { compact: true })} meta={`${money(team.data.totals.pipeline, undefined, { compact: true })} open`} icon={<IconTarget />} />
          <Stat label="Calls" value={number(team.data.totals.calls)} meta={`${team.data.totals.connected} connected · ${team.data.totals.talkHours}h talk`} icon={<IconChart />} />
          <Stat
            label="Quota attainment"
            value={team.data.totals.quota ? percent((team.data.totals.revenue / team.data.totals.quota) * 100) : '--'}
            meta={team.data.totals.quota ? `against ${money(team.data.totals.quota, undefined, { compact: true })}` : 'no quotas set'}
            icon={<IconClock />}
          />
        </div>
      )}

      <div className="grid grid-main">
        <Card title="Conversion funnel" subtitle="Every deal that entered the pipeline in the period">
          {funnel.loading ? <Spinner /> : funnel.error ? <ErrorState error={funnel.error} /> : (
            <FunnelChart
              stages={funnel.data?.funnel || []}
              empty={<EmptyState title="No deals in the pipeline yet" />}
            />
          )}
        </Card>

        <Card title="Revenue by month" subtitle="Closed-won">
          {revenue.loading ? <Spinner /> : revenueRows.length === 0 ? <EmptyState title="No closed revenue yet" /> : (
            <BarChart
              data={revenueRows.map((row) => ({ label: row.month, value: row.revenue }))}
              format={(value) => money(value, undefined, { compact: true })}
              height={170}
            />
          )}
        </Card>
      </div>

      {isManager && team.data?.callsByDay?.length > 0 && (
        <Card title="Call activity" subtitle="Calls and connects per day">
          <LineChart
            height={190}
            xLabels={team.data.callsByDay.map((row) => row.day)}
            series={[
              { label: 'Calls', points: team.data.callsByDay.map((row) => row.calls), fill: true },
              { label: 'Connected', points: team.data.callsByDay.map((row) => row.connected), color: 'var(--success)' },
            ]}
          />
        </Card>
      )}

      <Card
        title="Reports"
        subtitle="Server-generated, exportable"
        actions={(
          <select className="select" style={{ maxWidth: 260 }} value={report} onChange={(event) => setReport(event.target.value)} aria-label="Choose report">
            {(catalogue.data?.reports || []).filter((entry) => !entry.endpoint).map((entry) => (
              <option key={entry.key} value={entry.key}>{entry.label}</option>
            ))}
          </select>
        )}
        flush
      >
        <div className="card-body-pad" style={{ paddingBottom: 0 }}>
          <span className="small secondary">
            {(catalogue.data?.reports || []).find((entry) => entry.key === report)?.description}
          </span>
        </div>
        {reportData.loading ? (
          <div className="card-body-pad"><Spinner label="Building report" /></div>
        ) : reportData.error ? (
          <div className="card-body-pad"><ErrorState error={reportData.error} onRetry={reportData.refetch} /></div>
        ) : (
          <ReportTable rows={reportData.data?.rows} />
        )}
      </Card>

      {aiUsage.data && (
        <div className="grid grid-main">
          <Card title="AI usage" subtitle={`${number(aiUsage.data.totals.calls)} requests in the period`}>
            <DataTable
              columns={[
                { key: 'feature', label: 'Feature', render: (row) => titleCase(row.feature) },
                { key: 'provider', label: 'Provider', render: (row) => <Badge tone={row.provider === 'anthropic' ? 'accent' : 'outline'}>{row.provider}</Badge> },
                { key: 'calls', label: 'Requests', numeric: true, render: (row) => <span className="tabular">{number(row.calls)}</span> },
                { key: 'tokens', label: 'Tokens', numeric: true, render: (row) => <span className="tabular">{number((row.input_tokens || 0) + (row.output_tokens || 0))}</span> },
                { key: 'latency', label: 'Avg latency', numeric: true, render: (row) => <span className="tabular">{row.avg_latency_ms ? `${row.avg_latency_ms} ms` : '--'}</span> },
                { key: 'failures', label: 'Failures', numeric: true, render: (row) => (row.failures ? <Badge tone="danger">{row.failures}</Badge> : <span className="muted">0</span>) },
              ]}
              rows={aiUsage.data.byFeature}
              rowKey={(row) => `${row.feature}-${row.provider}`}
              empty={<EmptyState title="No AI usage recorded yet" />}
            />
          </Card>

          <Card title="AI engine">
            <DonutChart
              size={120}
              centerValue={number(aiUsage.data.totals.calls)}
              centerLabel="requests"
              data={aiUsage.data.byFeature.map((row) => ({ label: titleCase(row.feature), value: row.calls }))}
            />
            <span className="xs muted">
              Active provider: {aiUsage.data.status.activeProvider} ({aiUsage.data.status.model}).
              Prompt version {aiUsage.data.status.promptVersion}.
            </span>
          </Card>
        </div>
      )}
    </>
  );
}
