import type { RunEvent } from '@bdiff/core';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/** A request's state: loading, its data, or why it failed. */
export interface Loaded<T> {
  readonly data?: T;
  readonly error?: string;
  readonly loading: boolean;
  /** Fetches again now. */
  readonly reload: () => void;
}

/** GETs JSON from the panel's API. */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${String(response.status)} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** POSTs to the panel's API (same origin, so the server accepts it). */
export async function postJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `${String(response.status)} ${response.statusText}`);
  }
  return body;
}

/**
 * Fetches `url`, then again every `intervalMs` while the page is visible (0: once). Keeps the last
 * data while a refresh is in flight, so the page never flashes.
 */
export function usePolling<T>(url: string | null, intervalMs: number): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);
  useEffect(() => {
    if (url === null) {
      return undefined;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const data = await getJson<T>(url, controller.signal);
        setState({ data, loading: false });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState((previous) => ({
            ...previous,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      if (intervalMs > 0 && !controller.signal.aborted) {
        timer = setTimeout(() => void load(), document.hidden ? intervalMs * 5 : intervalMs);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, intervalMs, tick]);
  return { ...state, reload };
}

/**
 * The live events of a run: starts from `initial` and follows `/api/runs/:id/events` while
 * `active`. The browser resumes a dropped stream from the last event it saw (`Last-Event-ID`); a
 * `reset` (the demo replay restarting) clears the list; `end` closes the stream and calls
 * `onEnd`.
 */
export function useRunEvents(
  runId: string,
  initial: readonly RunEvent[],
  active: boolean,
  onEnd?: () => void,
): readonly RunEvent[] {
  const [events, setEvents] = useState<readonly RunEvent[]>(initial);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    setEvents(initial);
  }, [runId, initial]);
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    let seen: RunEvent[] = [];
    const flush = () => {
      setEvents([...seen]);
    };
    source.addEventListener('run-event', (message) => {
      seen.push(JSON.parse((message as MessageEvent<string>).data) as RunEvent);
      flush();
    });
    source.addEventListener('reset', () => {
      seen = [];
      flush();
    });
    source.addEventListener('end', () => {
      source.close();
      endRef.current?.();
    });
    return () => {
      source.close();
    };
  }, [runId, active]);
  return events;
}

/** The current time, updated every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

/** The hash route: `#/runs`, `#/runs/<id>`, `#/fixture`. */
export type Route =
  | { readonly screen: 'runs' }
  | { readonly screen: 'run'; readonly runId: string }
  | { readonly screen: 'fixture' };

/** Parses `location.hash`. Pure. */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'runs' && parts[1] !== undefined && parts[1] !== '') {
    return { screen: 'run', runId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'fixture') {
    return { screen: 'fixture' };
  }
  return { screen: 'runs' };
}

/** The hash of a route. Pure. */
export function routeHref(route: Route): string {
  switch (route.screen) {
    case 'runs':
      return '#/runs';
    case 'run':
      return `#/runs/${encodeURIComponent(route.runId)}`;
    case 'fixture':
      return '#/fixture';
  }
}

/** The current route, following hash changes. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return route;
}
