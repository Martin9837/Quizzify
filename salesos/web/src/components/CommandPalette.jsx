import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import api from '../lib/api.js';
import { useDebounced } from '../lib/hooks.js';
import { IconSearch, IconSparkles, IconPhone, IconPlus, IconUsers, IconPipeline, IconChart } from './Icons.jsx';
import { titleCase } from '../lib/format.js';

/**
 * Command palette (cmd/ctrl-K).
 *
 * Search-first navigation: one keystroke to reach any record, plus the actions
 * an agent takes dozens of times a day. Typing a question routes to the AI
 * assistant instead of searching, because "who should I call today" is not a
 * record lookup.
 */

const ACTIONS = [
  { id: 'new-lead', label: 'Add lead', hint: 'Create a new lead', icon: <IconPlus />, to: '/leads?new=1' },
  { id: 'call', label: 'Start a call', hint: 'Open the call console', icon: <IconPhone />, to: '/calls' },
  { id: 'pipeline', label: 'Go to pipeline', icon: <IconPipeline />, to: '/pipeline' },
  { id: 'leads', label: 'Go to leads', icon: <IconUsers />, to: '/leads' },
  { id: 'conversations', label: 'Go to conversations', icon: <IconSparkles />, to: '/conversations' },
  { id: 'analytics', label: 'Go to analytics', icon: <IconChart />, to: '/analytics' },
  { id: 'insights', label: 'AI sales intelligence', icon: <IconSparkles />, to: '/insights' },
  { id: 'tasks', label: 'Go to tasks', icon: <IconPlus />, to: '/tasks' },
];

export default function CommandPalette({ open, onClose, onAskAi }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const debounced = useDebounced(query, 180);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => {
    if (!open || debounced.trim().length < 2) {
      setResults([]);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    api.get('/search/suggest', { q: debounced }, { signal: controller.signal })
      .then((data) => setResults(data.suggestions || []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [debounced, open]);

  const looksLikeQuestion = query.trim().length > 12
    && (/\?$/.test(query.trim()) || /^(who|what|which|why|how|when|show|summar|draft|list)/i.test(query.trim()));

  const items = useMemo(() => {
    const actionMatches = ACTIONS.filter((action) => !query || action.label.toLowerCase().includes(query.toLowerCase()));
    const recordItems = results.map((result) => ({
      id: `${result.type}-${result.entityId}`,
      label: result.label,
      hint: result.sublabel,
      group: titleCase(result.type),
      to: result.href,
      icon: <IconSearch />,
    }));
    const askItem = query.trim().length > 3
      ? [{
        id: 'ask-ai',
        label: `Ask AI: “${query.trim()}”`,
        hint: 'Answer from your CRM data',
        group: 'Assistant',
        icon: <IconSparkles />,
        action: () => {
          onAskAi?.(query.trim());
          onClose();
        },
      }]
      : [];
    return looksLikeQuestion
      ? [...askItem, ...recordItems, ...actionMatches.map((a) => ({ ...a, group: 'Actions' }))]
      : [...recordItems, ...actionMatches.map((a) => ({ ...a, group: 'Actions' })), ...askItem];
  }, [results, query, looksLikeQuestion, onAskAi, onClose]);

  useEffect(() => {
    setCursor(0);
  }, [items.length]);

  const choose = (item) => {
    if (!item) return;
    if (item.action) item.action();
    else if (item.to) {
      navigate(item.to);
      onClose();
    }
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') return onClose();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      return setCursor((value) => Math.min(items.length - 1, value + 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      return setCursor((value) => Math.max(0, value - 1));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      return choose(items[cursor]);
    }
    return undefined;
  };

  if (!open) return null;

  const groups = items.reduce((acc, item) => {
    const group = item.group || 'Results';
    acc[group] = acc[group] || [];
    acc[group].push(item);
    return acc;
  }, {});

  let flatIndex = -1;

  return createPortal(
    <div className="palette-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <span className="muted"><IconSearch size={18} /></span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search leads, deals, calls -- or ask a question"
            aria-label="Search or ask"
            autoComplete="off"
          />
          {loading && <span className="spinner" />}
        </div>
        <div className="palette-results">
          {items.length === 0 && (
            <div className="empty small">Start typing to search leads, companies, deals and conversations.</div>
          )}
          {Object.entries(groups).map(([group, groupItems]) => (
            <div key={group}>
              <div className="palette-group-label uppercase muted">{group}</div>
              {groupItems.map((item) => {
                flatIndex += 1;
                const index = flatIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`palette-item ${cursor === index ? 'active' : ''}`}
                    style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left' }}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => choose(item)}
                  >
                    <span className="muted">{item.icon}</span>
                    <span className="grow truncate">
                      <span className="strong">{item.label}</span>
                      {item.hint && <span className="muted small"> — {item.hint}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-footer row-tight xs muted">
          <kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close
          <span className="right">Ask a question to use the AI assistant</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
