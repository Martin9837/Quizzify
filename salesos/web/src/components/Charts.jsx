import { useId, useMemo, useState } from 'react';
import { money, number as formatNumber, percent } from '../lib/format.js';

/**
 * Charts are hand-rolled SVG rather than a charting library.
 *
 * The set of shapes this product needs is small and fixed, and hand-drawn SVG
 * inherits the theme tokens directly -- so light/dark, print and high-contrast
 * all work without a second styling system. Every chart is keyboard and
 * screen-reader accessible via a text summary.
 */

const SERIES_COLORS = [
  'var(--accent)', 'var(--purple)', 'var(--success)', 'var(--warning)',
  'var(--info)', 'var(--danger)', 'var(--cold)',
];

function useScale(values, { padTop = 1.08 } = {}) {
  return useMemo(() => {
    const max = Math.max(...values, 0);
    return max === 0 ? 1 : max * padTop;
  }, [values, padTop]);
}

/* ------------------------------------------------------------- bar chart */
export function BarChart({ data, valueKey = 'value', labelKey = 'label', height = 180, format = formatNumber, color, horizontal = false }) {
  const [hover, setHover] = useState(null);
  const values = data.map((d) => Number(d[valueKey]) || 0);
  const scale = useScale(values);
  const titleId = useId();

  if (!data.length) return <div className="empty small">No data for this period</div>;

  if (horizontal) {
    return (
      <div className="col-tight" role="img" aria-labelledby={titleId}>
        <span id={titleId} className="sr-only">
          Bar chart: {data.map((d) => `${d[labelKey]} ${format(d[valueKey])}`).join(', ')}
        </span>
        {data.map((entry, index) => (
          <div key={entry[labelKey] ?? index} className="col-tight" style={{ gap: 3 }}>
            <div className="between small">
              <span className="truncate">{entry[labelKey]}</span>
              <span className="tabular strong">{format(entry[valueKey])}</span>
            </div>
            <div className="meter" style={{ height: 8 }}>
              <span style={{
                width: `${((Number(entry[valueKey]) || 0) / scale) * 100}%`,
                background: entry.color || color || SERIES_COLORS[index % SERIES_COLORS.length],
              }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const width = 100;
  const gap = data.length > 14 ? 0.6 : 1.6;
  const barWidth = (width - gap * (data.length - 1)) / data.length;

  return (
    <div className="col-tight">
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-labelledby={titleId}>
        <title id={titleId}>Bar chart</title>
        {[0.25, 0.5, 0.75, 1].map((fraction) => (
          <line key={fraction} className="chart-grid-line" x1="0" x2={width} y1={height * fraction} y2={height * fraction} vectorEffect="non-scaling-stroke" />
        ))}
        {data.map((entry, index) => {
          const value = Number(entry[valueKey]) || 0;
          const barHeight = Math.max(1, (value / scale) * (height - 14));
          return (
            <rect
              key={entry[labelKey] ?? index}
              x={index * (barWidth + gap)}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx="1"
              fill={entry.color || color || 'var(--accent)'}
              opacity={hover === null || hover === index ? 1 : 0.45}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>
      <div className="between xs muted">
        <span>{data[0]?.[labelKey]}</span>
        {hover !== null && (
          <span className="strong" style={{ color: 'var(--text)' }}>
            {data[hover][labelKey]}: {format(data[hover][valueKey])}
          </span>
        )}
        <span>{data[data.length - 1]?.[labelKey]}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ line chart */
export function LineChart({ series, height = 200, format = formatNumber, xLabels = [] }) {
  const titleId = useId();
  const [hover, setHover] = useState(null);
  const width = 100;
  const allValues = series.flatMap((s) => s.points.map((p) => Number(p) || 0));
  const scale = useScale(allValues);
  const count = Math.max(...series.map((s) => s.points.length), 1);

  if (!allValues.length) return <div className="empty small">No data for this period</div>;

  const pathFor = (points) => points
    .map((value, index) => {
      const x = count === 1 ? width / 2 : (index / (count - 1)) * width;
      const y = height - ((Number(value) || 0) / scale) * (height - 12) - 6;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div className="col-tight">
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-labelledby={titleId}>
        <title id={titleId}>
          Line chart: {series.map((s) => `${s.label} peaking at ${format(Math.max(...s.points))}`).join('; ')}
        </title>
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
          <line key={fraction} className="chart-grid-line" x1="0" x2={width} y1={height * fraction} y2={height * fraction} vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((entry, index) => (
          <g key={entry.label}>
            {entry.fill && (
              <path
                d={`${pathFor(entry.points)} L${width},${height} L0,${height} Z`}
                fill={entry.color || SERIES_COLORS[index % SERIES_COLORS.length]}
                opacity="0.12"
              />
            )}
            <path
              d={pathFor(entry.points)}
              fill="none"
              stroke={entry.color || SERIES_COLORS[index % SERIES_COLORS.length]}
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </g>
        ))}
        {/* Invisible hit areas give a tooltip without a charting library. */}
        {Array.from({ length: count }).map((_, index) => (
          <rect
            key={index}
            x={(index / count) * width}
            y="0"
            width={width / count}
            height={height}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {hover !== null && (
          <line
            className="chart-grid-line"
            x1={count === 1 ? width / 2 : (hover / (count - 1)) * width}
            x2={count === 1 ? width / 2 : (hover / (count - 1)) * width}
            y1="0" y2={height}
            stroke="var(--accent)"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="between">
        <div className="legend">
          {series.map((entry, index) => (
            <span key={entry.label}>
              <span className="legend-swatch" style={{ background: entry.color || SERIES_COLORS[index % SERIES_COLORS.length] }} />
              {entry.label}
              {hover !== null && <strong className="tabular"> {format(entry.points[hover] ?? 0)}</strong>}
            </span>
          ))}
        </div>
        {hover !== null && xLabels[hover] && <span className="xs muted">{xLabels[hover]}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ donut chart */
export function DonutChart({ data, size = 140, thickness = 16, format = formatNumber, centerLabel, centerValue }) {
  const titleId = useId();
  const total = data.reduce((sum, entry) => sum + (Number(entry.value) || 0), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  if (!total) return <div className="empty small">No data</div>;

  return (
    <div className="row gap-4 wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={titleId}>
        <title id={titleId}>
          Donut chart: {data.map((entry) => `${entry.label} ${percent((entry.value / total) * 100)}`).join(', ')}
        </title>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {data.map((entry, index) => {
            const value = Number(entry.value) || 0;
            const length = (value / total) * circumference;
            const circle = (
              <circle
                key={entry.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={entry.color || SERIES_COLORS[index % SERIES_COLORS.length]}
                strokeWidth={thickness}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += length;
            return circle;
          })}
        </g>
        {(centerValue || centerLabel) && (
          <>
            <text x="50%" y="47%" textAnchor="middle" fontSize="18" fontWeight="700" fill="var(--text)">{centerValue}</text>
            <text x="50%" y="62%" textAnchor="middle" fontSize="9" fill="var(--text-muted)">{centerLabel}</text>
          </>
        )}
      </svg>
      <div className="col-tight grow" style={{ minWidth: 140 }}>
        {data.map((entry, index) => (
          <div key={entry.label} className="between small">
            <span className="row-tight truncate">
              <span className="legend-swatch" style={{ background: entry.color || SERIES_COLORS[index % SERIES_COLORS.length] }} />
              {entry.label}
            </span>
            <span className="tabular strong">{format(entry.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- sparkline */
export function Sparkline({ points, height = 32, color = 'var(--accent)', showArea = true }) {
  const values = (points || []).map((p) => Number(p) || 0);
  if (values.length < 2) return <div className="skeleton" style={{ height }} />;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const width = 100;
  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * (height - 4) - 2;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden>
      {showArea && <path d={`${path} L${width},${height} L0,${height} Z`} fill={color} opacity="0.14" />}
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/* --------------------------------------------------------------- score ring */
export function ScoreRing({ score, size = 64, thickness = 6, label }) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const color = value >= 75 ? 'var(--success)' : value >= 55 ? 'var(--warning)' : 'var(--danger)';
  return (
    <div className="score-ring" style={{ width: size, height: size }} title={label ? `${label}: ${value}` : `${value} out of 100`}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--bg-active)" strokeWidth={thickness} />
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={thickness}
            strokeDasharray={`${(value / 100) * circumference} ${circumference}`} strokeLinecap="round"
          />
        </g>
      </svg>
      <span className="score-value" style={{ color }}>{Math.round(value)}</span>
    </div>
  );
}

/* --------------------------------------------------------------- funnel */
export function FunnelChart({ stages, format = formatNumber }) {
  const top = stages[0]?.deals || 1;
  return (
    <div className="col-tight">
      {stages.map((stage, index) => {
        const width = Math.max(6, ((stage.deals || 0) / top) * 100);
        return (
          <div key={stage.stage} className="col-tight" style={{ gap: 3 }}>
            <div className="between small">
              <span className="row-tight">
                <span className="strong">{stage.label}</span>
                {stage.conversionFromPrevious !== null && stage.conversionFromPrevious !== undefined && (
                  <span className={stage.conversionFromPrevious < 45 ? 'badge danger' : 'badge outline'}>
                    {stage.conversionFromPrevious}% from previous
                  </span>
                )}
              </span>
              <span className="tabular strong">{format(stage.deals)}</span>
            </div>
            <div style={{
              height: 22, width: `${width}%`, minWidth: 40, borderRadius: 'var(--radius-sm)',
              background: `linear-gradient(90deg, var(--accent), ${SERIES_COLORS[(index + 1) % SERIES_COLORS.length]})`,
              opacity: 1 - index * 0.07,
            }} />
          </div>
        );
      })}
    </div>
  );
}

/** Horizontal stacked bar -- used for pipeline value by stage. */
export function StackedBar({ segments, format = money, height = 22 }) {
  const total = segments.reduce((sum, segment) => sum + (Number(segment.value) || 0), 0);
  if (!total) return <div className="meter" style={{ height }} />;
  // Resolve each segment's colour once, before any filtering. Assigning colours
  // by array index in two places and filtering one of them is how a legend ends
  // up disagreeing with the chart it labels.
  const resolved = segments.map((segment, index) => ({
    ...segment,
    color: segment.color || SERIES_COLORS[index % SERIES_COLORS.length],
    share: (Number(segment.value) || 0) / total,
  }));
  return (
    <div className="col-tight">
      <div style={{ display: 'flex', height, borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
        {resolved.map((segment) => (
          <div
            key={segment.label}
            title={`${segment.label}: ${format(segment.value)}`}
            style={{ width: `${segment.share * 100}%`, background: segment.color }}
          />
        ))}
      </div>
      <div className="legend xs">
        {resolved.filter((segment) => segment.value > 0).map((segment) => (
          <span key={segment.label}>
            <span className="legend-swatch" style={{ background: segment.color }} />
            {segment.label} {format(segment.value, undefined, { compact: true })}
          </span>
        ))}
      </div>
    </div>
  );
}

export { SERIES_COLORS };
