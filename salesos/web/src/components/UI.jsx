import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { avatarColor, initials, titleCase } from '../lib/format.js';
import { IconX, IconSearch, IconAlert, IconCheckCircle, IconChevronDown } from './Icons.jsx';

/* ------------------------------------------------------------------ layout */
export function Card({ title, subtitle, actions, children, flush = false, className = '', ...rest }) {
  return (
    <section className={`card ${flush ? 'flush' : ''} ${className}`} {...rest}>
      {(title || actions) && (
        <header className="card-header" style={flush ? { padding: 'var(--space-4) var(--space-4) 0' } : undefined}>
          {/* `card-title-row` centres its children; stacking a subtitle under the
              title needs column flow with left alignment, not both classes. */}
          <div className="col-tight" style={{ gap: 2, minWidth: 0, alignItems: 'flex-start' }}>
            {title && <h3>{title}</h3>}
            {subtitle && <span className="small muted">{subtitle}</span>}
          </div>
          {actions && <div className="row-tight">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, meta, trend, icon, accent }) {
  return (
    <div className="stat">
      <div className="between">
        <span className="stat-label">{label}</span>
        {icon && <span style={{ color: accent || 'var(--text-muted)' }}>{icon}</span>}
      </div>
      <span className="stat-value" style={accent ? { color: accent } : undefined}>{value}</span>
      {(meta || trend) && (
        <span className="stat-meta">
          {trend !== undefined && trend !== null && (
            <span className={`stat-trend ${trend >= 0 ? 'up' : 'down'}`}>
              {trend >= 0 ? '+' : ''}{trend}%
            </span>
          )}
          {meta}
        </span>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, children }) {
  return (
    <header className="page-header">
      <div className="page-title">
        <h1>{title}</h1>
        {subtitle && <span className="secondary small">{subtitle}</span>}
        {children}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/* ------------------------------------------------------------------ atoms */
export function Badge({ children, tone, className = '', dot = false, title }) {
  const toneClass = tone ? String(tone).toLowerCase().replace(/\s+/g, '_') : '';
  return <span className={`badge ${toneClass} ${dot ? 'dot' : ''} ${className}`} title={title}>{children}</span>;
}

export function Avatar({ name, color, size = '', title }) {
  return (
    <span
      className={`avatar ${size}`}
      style={{ background: color || avatarColor(name) }}
      title={title || name}
      aria-hidden={!title}
    >
      {initials(name)}
    </span>
  );
}

export function Spinner({ large = false, label }) {
  return (
    <span className="row-tight" role="status" aria-live="polite">
      <span className={`spinner ${large ? 'lg' : ''}`} />
      {label && <span className="small muted">{label}</span>}
      {!label && <span className="sr-only">Loading</span>}
    </span>
  );
}

export function Meter({ value, max = 100, tone, label }) {
  const pct = Math.max(0, Math.min(100, ((Number(value) || 0) / (max || 1)) * 100));
  return (
    <div className="col-tight" style={{ gap: 4 }}>
      {label && <div className="between small"><span className="muted">{label}</span><span className="tabular">{Math.round(pct)}%</span></div>}
      <div className={`meter ${tone || ''}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, message, action }) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon">{icon}</span>}
      <div className="col-tight" style={{ alignItems: 'center', gap: 4 }}>
        <strong style={{ color: 'var(--text)' }}>{title}</strong>
        {message && <span className="small">{message}</span>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="banner danger">
      <IconAlert />
      <div className="grow">
        <strong>{error?.message || 'Something went wrong'}</strong>
        {error?.details && Array.isArray(error.details) && (
          <ul className="list-bullets small mt-2">
            {error.details.map((detail, index) => (
              <li key={index}>{detail.field ? `${detail.field}: ` : ''}{detail.message}</li>
            ))}
          </ul>
        )}
        {error?.requestId && <div className="xs muted mt-2 mono">Request {error.requestId}</div>}
      </div>
      {onRetry && <button type="button" className="btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Skeleton({ rows = 3, height = 14 }) {
  return (
    <div className="col-tight" aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" style={{ height, width: `${100 - index * 8}%` }} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */
export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function TextField({ label, hint, error, className = '', ...rest }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <input id={id} className={`input ${error ? 'invalid' : ''} ${className}`} {...rest} />
    </Field>
  );
}

export function TextArea({ label, hint, error, className = '', ...rest }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <textarea id={id} className={`textarea ${error ? 'invalid' : ''} ${className}`} {...rest} />
    </Field>
  );
}

export function SelectField({ label, hint, error, options = [], placeholder, className = '', ...rest }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <select id={id} className={`select ${className}`} {...rest}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => {
          const value = typeof option === 'string' ? option : option.value;
          const text = typeof option === 'string' ? titleCase(option) : option.label;
          return <option key={value} value={value}>{text}</option>;
        })}
      </select>
    </Field>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search', ...rest }) {
  return (
    <label className="search-input grow">
      <span className="sr-only">{placeholder}</span>
      <span className="search-icon"><IconSearch /></span>
      <input
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        {...rest}
      />
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="track" />
      {label && <span className="small">{label}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, indeterminate = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="checkbox">
      <input ref={ref} type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} />
      {label && <span className="small">{label}</span>}
    </label>
  );
}

export function Tabs({ tabs, active, onChange, className = '' }) {
  return (
    <div className={`pill-tabs ${className}`} role="tablist">
      {tabs.map((tab) => {
        const key = typeof tab === 'string' ? tab : tab.key;
        const label = typeof tab === 'string' ? titleCase(tab) : tab.label;
        const count = typeof tab === 'object' ? tab.count : undefined;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            className={active === key ? 'active' : ''}
            onClick={() => onChange(key)}
          >
            {label}
            {count !== undefined && count !== null && <span className="muted"> {count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- overlays */
function useEscape(onClose, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, active]);
}

/** Trap focus inside a dialog so keyboard users cannot tab out behind it. */
function useFocusTrap(ref, active = true) {
  useEffect(() => {
    if (!active || !ref.current) return undefined;
    const container = ref.current;
    const previous = document.activeElement;
    const focusables = () => [...container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.offsetParent !== null);

    const first = focusables()[0];
    (first || container).focus?.();

    const onKeyDown = (event) => {
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [ref, active]);
}

export function Modal({ open, onClose, title, children, footer, size = '' }) {
  const ref = useRef(null);
  useEscape(onClose, open);
  useFocusTrap(ref, open);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <header className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Close"><IconX /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, footer, wide = false, actions }) {
  const ref = useRef(null);
  useEscape(onClose, open);
  useFocusTrap(ref, open);
  if (!open) return null;
  return createPortal(
    <>
      <div className="drawer-overlay" onMouseDown={onClose} />
      <aside className={`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <header className="drawer-header">
          <h3 className="truncate">{title}</h3>
          <div className="row-tight">
            {actions}
            <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Close"><IconX /></button>
          </div>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-footer">{footer}</footer>}
      </aside>
    </>,
    document.body,
  );
}

export function Confirm({ open, title, message, confirmLabel = 'Confirm', tone = 'primary', onConfirm, onCancel, pending }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={(
        <>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className={`btn ${tone}`} onClick={onConfirm} disabled={pending}>
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </button>
        </>
      )}
    >
      <p className="secondary">{message}</p>
    </Modal>
  );
}

/* ------------------------------------------------------------------ toasts */
const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);

  const push = useCallback((message, tone = 'info', timeout = 4200) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current, { id, message, tone }]);
    if (timeout) setTimeout(() => dismiss(id), timeout);
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({
    push,
    success: (message) => push(message, 'success'),
    error: (message) => push(typeof message === 'string' ? message : message?.message || 'Something went wrong', 'error', 6500),
    info: (message) => push(message, 'info'),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-stack" role="region" aria-live="polite" aria-label="Notifications">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.tone}`}>
              {toast.tone === 'success' ? <IconCheckCircle /> : toast.tone === 'error' ? <IconAlert /> : null}
              <span className="grow small">{toast.message}</span>
              <button type="button" className="btn ghost icon sm" onClick={() => dismiss(toast.id)} aria-label="Dismiss"><IconX /></button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext) || { push: () => {}, success: () => {}, error: () => {}, info: () => {}, dismiss: () => {} };
}

/* ------------------------------------------------------------------ table */
export function DataTable({ columns, rows, onRowClick, empty, rowKey = (row) => row.id, selected, onSelect, sort, onSort }) {
  if (!rows?.length) return empty || <EmptyState title="Nothing here yet" />;
  const selectable = Boolean(onSelect);
  const allSelected = selectable && rows.every((row) => selected?.includes(rowKey(row)));

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: 34 }}>
                <Checkbox
                  checked={allSelected}
                  indeterminate={!allSelected && rows.some((row) => selected?.includes(rowKey(row)))}
                  onChange={(checked) => onSelect(checked ? rows.map(rowKey) : [])}
                />
              </th>
            )}
            {columns.map((column) => (
              <th
                key={column.key}
                className={`${column.numeric ? 'num' : ''} ${column.sortKey && onSort ? 'sortable' : ''}`}
                style={column.width ? { width: column.width } : undefined}
                onClick={column.sortKey && onSort ? () => onSort(column.sortKey) : undefined}
              >
                {column.label}
                {column.sortKey && sort && (sort === column.sortKey || sort === `-${column.sortKey}`) && (
                  <span className="muted"> {sort.startsWith('-') ? '↓' : '↑'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={`${onRowClick ? 'clickable' : ''} ${selected?.includes(key) ? 'selected' : ''}`}
                onClick={onRowClick ? (event) => {
                  if (event.target.closest('input, button, a')) return;
                  onRowClick(row);
                } : undefined}
              >
                {selectable && (
                  <td>
                    <Checkbox
                      checked={selected?.includes(key)}
                      onChange={(checked) => onSelect(checked ? [...(selected || []), key] : (selected || []).filter((id) => id !== key))}
                    />
                  </td>
                )}
                {columns.map((column) => (
                  <td key={column.key} className={column.numeric ? 'num' : ''}>
                    {column.render ? column.render(row) : row[column.key]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------------- disclosure */
export function Accordion({ title, children, defaultOpen = false, meta }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="col-tight">
      <button
        type="button"
        className="between"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{ background: 'transparent', border: 0, padding: 'var(--space-2) 0', width: '100%', textAlign: 'left' }}
      >
        <span className="row-tight strong">{title}</span>
        <span className="row-tight muted small">
          {meta}
          <span style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }}><IconChevronDown /></span>
        </span>
      </button>
      {open && <div className="col-tight">{children}</div>}
    </div>
  );
}

export function KeyValue({ items }) {
  return (
    <dl className="kv">
      {items.filter((item) => item && item.value !== undefined && item.value !== null && item.value !== '').map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
