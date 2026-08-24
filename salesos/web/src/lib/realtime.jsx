import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getAccessToken } from './api.js';
import { useAuth } from './auth.jsx';

/**
 * Realtime context over Server-Sent Events.
 *
 * Components subscribe to named events; the provider owns exactly one
 * connection and re-establishes it with backoff. Because the browser cannot set
 * headers on an EventSource, the access token travels as a query parameter to
 * an endpoint that accepts nothing else.
 */
const RealtimeContext = createContext(null);

export function RealtimeProvider({ children }) {
  const { status } = useAuth();
  const handlers = useRef(new Map());
  const sourceRef = useRef(null);
  const attemptRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);

  const emit = useCallback((event, payload) => {
    setLastEvent({ event, payload, at: Date.now() });
    for (const handler of handlers.current.get(event) || []) {
      try {
        handler(payload);
      } catch (error) {
        console.error('realtime handler failed', event, error);
      }
    }
    for (const handler of handlers.current.get('*') || []) handler({ event, payload });
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return undefined;
    let cancelled = false;
    let retryTimer = null;

    const EVENTS = [
      'connected', 'activity.created', 'notification.created', 'notification.read',
      'call.started', 'call.answered', 'call.updated', 'call.ended', 'call.incoming',
      'call.ai_status', 'transcript.ready', 'analysis.ready', 'ai.suggestions.ready',
      'email.sent', 'manager.alert', 'import.complete',
    ];

    const connect = () => {
      if (cancelled) return;
      const token = getAccessToken();
      if (!token) return;
      const source = new EventSource(`/api/v1/events?access_token=${encodeURIComponent(token)}`);
      sourceRef.current = source;

      source.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
      };
      source.onerror = () => {
        setConnected(false);
        source.close();
        if (cancelled) return;
        // Exponential backoff, capped, so a server restart does not hammer it.
        attemptRef.current += 1;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attemptRef.current, 5));
        retryTimer = setTimeout(connect, delay);
      };
      for (const event of EVENTS) {
        source.addEventListener(event, (message) => {
          let payload = null;
          try {
            payload = JSON.parse(message.data);
          } catch {
            payload = message.data;
          }
          emit(event, payload);
        });
      }
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      sourceRef.current?.close();
      setConnected(false);
    };
  }, [status, emit]);

  const subscribe = useCallback((event, handler) => {
    const list = handlers.current.get(event) || [];
    list.push(handler);
    handlers.current.set(event, list);
    return () => {
      handlers.current.set(event, (handlers.current.get(event) || []).filter((h) => h !== handler));
    };
  }, []);

  const value = useMemo(() => ({ connected, subscribe, lastEvent }), [connected, subscribe, lastEvent]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  return useContext(RealtimeContext) || { connected: false, subscribe: () => () => {}, lastEvent: null };
}

/** Subscribe to one realtime event for the lifetime of a component. */
export function useRealtimeEvent(event, handler) {
  const { subscribe } = useRealtime();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(event, (payload) => ref.current?.(payload)), [event, subscribe]);
}
