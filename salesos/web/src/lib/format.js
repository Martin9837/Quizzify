/** Presentation helpers. Every number and date in the UI goes through here. */

export function money(value, currency = 'USD', { compact = false } = {}) {
  const amount = Number(value) || 0;
  if (compact && Math.abs(amount) >= 1000) {
    const units = [
      { limit: 1e9, suffix: 'B' },
      { limit: 1e6, suffix: 'M' },
      { limit: 1e3, suffix: 'k' },
    ];
    const unit = units.find((u) => Math.abs(amount) >= u.limit);
    const scaled = amount / unit.limit;
    return `${currencySymbol(currency)}${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${unit.suffix}`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(amount);
}

function currencySymbol(currency) {
  return { USD: '$', EUR: '€', GBP: '£' }[currency] || '';
}

export const number = (value, options = {}) => new Intl.NumberFormat('en-US', options).format(Number(value) || 0);
export const percent = (value, digits = 0) => `${(Number(value) || 0).toFixed(digits)}%`;

export function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function date(value, options = {}) {
  if (!value) return '--';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...options });
}

export function dateTime(value) {
  if (!value) return '--';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function time(value) {
  if (!value) return '--';
  return new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "3 days ago" / "in 2 hours". Reads better than a timestamp in a feed. */
export function relative(value) {
  if (!value) return '--';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '--';
  const diffSeconds = Math.round((then - Date.now()) / 1000);
  const absolute = Math.abs(diffSeconds);
  const units = [
    { limit: 45, unit: 'second', divisor: 1 },
    { limit: 2700, unit: 'minute', divisor: 60 },
    { limit: 79200, unit: 'hour', divisor: 3600 },
    { limit: 2592000, unit: 'day', divisor: 86400 },
    { limit: 31536000, unit: 'month', divisor: 2592000 },
    { limit: Infinity, unit: 'year', divisor: 31536000 },
  ];
  const match = units.find((u) => absolute < u.limit);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  return formatter.format(Math.round(diffSeconds / match.divisor), match.unit);
}

export function dayLabel(value) {
  if (!value) return '--';
  const d = new Date(value);
  const today = new Date();
  const isSameDay = (a, b) => a.toDateString() === b.toDateString();
  const tomorrow = new Date(today.getTime() + 86400000);
  const yesterday = new Date(today.getTime() - 86400000);
  if (isSameDay(d, today)) return 'Today';
  if (isSameDay(d, tomorrow)) return 'Tomorrow';
  if (isSameDay(d, yesterday)) return 'Yesterday';
  return date(value, { year: undefined });
}

export const initials = (name) => String(name || '?')
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0].toUpperCase())
  .join('');

/** Deterministic avatar colour from a name, so identities stay stable. */
export function avatarColor(seed) {
  const palette = ['#2f6df6', '#e2694a', '#3f9f7f', '#8b5cf6', '#d4a017', '#0ea5a4', '#db2777', '#4f46e5', '#16a34a', '#f97316'];
  let hash = 0;
  for (const char of String(seed || '')) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return palette[hash % palette.length];
}

export const titleCase = (value) => String(value || '')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

export const sentenceCase = (value) => {
  const text = String(value || '').replace(/[_-]+/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
};

export const phone = (value) => {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+1') && digits.length === 12) {
    return `+1 (${digits.slice(2, 5)}) ${digits.slice(5, 8)}-${digits.slice(8)}`;
  }
  return value || '--';
};

/** Human-scaled elapsed time from a minute count: 42m, 6h, 26d. */
export function elapsedFromMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return '--';
  if (value < 60) return `${Math.round(value)}m`;
  const hours = value / 60;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export const pluralise = (count, singular, plural) => `${number(count)} ${count === 1 ? singular : plural || `${singular}s`}`;

/** Minimal markdown for assistant answers: bold, lists, and paragraphs. */
export function renderMarkdown(text) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = String(text || '').split('\n');
  const html = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const listMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(escape(listMatch[1]))}</li>`);
      continue;
    }
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
    if (!trimmed) continue;
    html.push(`<p>${inline(escape(trimmed))}</p>`);
  }
  if (inList) html.push('</ul>');
  return html.join('');
}

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
