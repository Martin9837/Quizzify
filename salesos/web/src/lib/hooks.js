import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from './api.js';

/**
 * Data-fetching hook with request cancellation and manual refetch.
 * Deliberately small: the app's data needs are request/response, not a cache.
 *
 * The hook refetches whenever `path` or the serialised `query` changes. That
 * makes it easy to write an accidental loop by passing a value that is new on
 * every render (`new Date().toISOString()` is the classic). The guard below
 * turns that mistake into one loud warning instead of a silent flood of
 * requests, because the symptom otherwise only shows up as rate-limit errors.
 */
export function useApi(path, query, { enabled = true, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, loading: Boolean(enabled), error: null });
  const queryKey = JSON.stringify(query || {});
  const mounted = useRef(true);
  const burst = useRef({ since: 0, count: 0, warned: false });

  const now = Date.now();
  if (now - burst.current.since > 1000) {
    burst.current = { since: now, count: 1, warned: burst.current.warned };
  } else {
    burst.current.count += 1;
    if (burst.current.count > 20 && !burst.current.warned) {
      burst.current.warned = true;
      console.warn(
        `useApi("${path}") re-ran ${burst.current.count} times in under a second. `
        + 'A value in the query object is probably recreated on every render -- memoise it.',
        query,
      );
    }
  }

  // Set on mount as well as cleared on unmount. Clearing alone looks harmless
  // but latches: React 18 mounts, cleans up, then mounts again in development,
  // so the flag went false and stayed there. The first request was aborted by
  // that cleanup and the second one succeeded -- and its result was then thrown
  // away by the `mounted.current` check below, leaving every screen on its
  // loading spinner for good. Production builds do not double-invoke effects,
  // which is why this only ever appeared under `npm run dev`.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (signal) => {
    if (!enabled || !path) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.get(path, query, { signal });
      if (mounted.current && !signal?.aborted) setState({ data, loading: false, error: null });
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (mounted.current) setState({ data: null, loading: false, error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryKey, enabled]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  const refetch = useCallback(() => load(new AbortController().signal), [load]);
  const setData = useCallback((updater) => {
    setState((prev) => ({ ...prev, data: typeof updater === 'function' ? updater(prev.data) : updater }));
  }, []);

  return { ...state, refetch, setData };
}

/** Debounce a fast-changing value (search boxes, filters). */
export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Persisted UI preference (theme, density, collapsed sidebar). */
export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : JSON.parse(stored);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}

/** A ticking clock, used by the live call timer. */
export function useTicker(intervalMs = 1000, active = true) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return tick;
}

export function useKeyboardShortcut(combo, handler, { enabled = true } = {}) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event) => {
      const wantsMeta = combo.includes('mod+');
      const key = combo.replace('mod+', '').toLowerCase();
      const metaPressed = event.metaKey || event.ctrlKey;
      if (wantsMeta && !metaPressed) return;
      if (!wantsMeta && metaPressed) return;
      if (event.key.toLowerCase() !== key) return;
      // Never hijack typing inside a field unless the shortcut needs a modifier.
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing && !wantsMeta) return;
      event.preventDefault();
      ref.current?.(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [combo, enabled]);
}

/** Async action with loading/error state, for buttons that mutate. */
export function useAction(action, { onSuccess, onError } = {}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (...args) => {
    setPending(true);
    setError(null);
    try {
      const result = await action(...args);
      onSuccess?.(result);
      return result;
    } catch (caught) {
      setError(caught);
      onError?.(caught);
      return undefined;
    } finally {
      setPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, onSuccess, onError]);
  return { run, pending, error, clearError: () => setError(null) };
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;
    const onChange = (event) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    setMatches(list.matches);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const useIsMobile = () => useMediaQuery('(max-width: 900px)');
