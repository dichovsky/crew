/**
 * Tests for the web API client (jsdom project): stubbed `fetch` and a fake
 * `EventSource` class prove the request URLs carry the page token, the
 * snapshot parses to the typed shape, failures reject loudly, and the SSE
 * subscription wires/unwires the 'change' listener without any polling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSnapshot, getToken, subscribeToChanges } from './api.js';
import type { WorkspaceSnapshot } from './types.js';

const TOKEN = 'test-token-123';

/** Point the jsdom page URL at a query string (the token rides in the URL). */
function setPageQuery(query: string): void {
  window.history.replaceState(null, '', query);
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }

  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances.length = 0;
  setPageQuery('/');
});

describe('getToken', () => {
  it('reads the token from the page URL query', () => {
    setPageQuery(`/?token=${TOKEN}`);
    expect(getToken()).toBe(TOKEN);
  });

  it('returns null when the URL carries no token', () => {
    setPageQuery('/');
    expect(getToken()).toBeNull();
  });
});

describe('fetchSnapshot', () => {
  it('requests /api/snapshot with the token and parses the typed snapshot', async () => {
    setPageQuery(`/?token=${TOKEN}`);
    const snapshot: WorkspaceSnapshot = { agents: [], tasks: [], messages: [] };
    const fetchStub = vi.fn<typeof fetch>(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(snapshot) } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchStub);

    const result = await fetchSnapshot();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(`/api/snapshot?token=${TOKEN}`);
    expect(result).toEqual(snapshot);
  });

  it('rejects with a clear Error on a non-200 response', async () => {
    setPageQuery(`/?token=${TOKEN}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        } as unknown as Response),
      ),
    );

    await expect(fetchSnapshot()).rejects.toThrow('Snapshot request failed: 401 Unauthorized');
  });

  it('rejects when the page URL carries no token', async () => {
    setPageQuery('/');
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    await expect(fetchSnapshot()).rejects.toThrow('Token not found');
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('subscribeToChanges', () => {
  it('opens /api/events with the token and delivers parsed change events', () => {
    setPageQuery(`/?token=${TOKEN}`);
    vi.stubGlobal('EventSource', FakeEventSource);
    const changes: unknown[] = [];

    subscribeToChanges({ onChange: (data) => changes.push(data) });

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(`/api/events?token=${TOKEN}`);

    source.emit('change', JSON.stringify({ maxMessageId: 7 }));
    expect(changes).toEqual([{ maxMessageId: 7 }]);

    // A non-JSON payload is delivered raw rather than dropped.
    source.emit('change', 'not-json');
    expect(changes).toEqual([{ maxMessageId: 7 }, 'not-json']);
  });

  it('dispatches the FR-U32 recovery events to their named handlers', () => {
    setPageQuery(`/?token=${TOKEN}`);
    vi.stubGlobal('EventSource', FakeEventSource);
    const seen: string[] = [];

    subscribeToChanges({
      onChange: () => seen.push('change'),
      onWorkspaceMissing: () => seen.push('missing'),
      onWorkspaceRestored: () => seen.push('restored'),
    });
    const source = FakeEventSource.instances[0]!;
    source.emit('workspace-missing', '{"reason":"gone"}');
    source.emit('workspace-restored', '{"reason":"back"}');
    source.emit('change', '{}');
    expect(seen).toEqual(['missing', 'restored', 'change']);
  });

  it('tolerates omitted recovery handlers (events are simply ignored)', () => {
    setPageQuery(`/?token=${TOKEN}`);
    vi.stubGlobal('EventSource', FakeEventSource);
    subscribeToChanges({ onChange: () => {} });
    const source = FakeEventSource.instances[0]!;
    expect(() => {
      source.emit('workspace-missing', '{}');
      source.emit('workspace-restored', '{}');
    }).not.toThrow();
  });

  it('returns an unsubscribe handle that closes the EventSource', () => {
    setPageQuery(`/?token=${TOKEN}`);
    vi.stubGlobal('EventSource', FakeEventSource);

    const subscription = subscribeToChanges({ onChange: () => {} });
    const source = FakeEventSource.instances[0]!;
    expect(source.closed).toBe(false);

    subscription.close();
    expect(source.closed).toBe(true);
  });

  it('throws without opening a stream when the URL carries no token', () => {
    setPageQuery('/');
    vi.stubGlobal('EventSource', FakeEventSource);

    expect(() => subscribeToChanges({ onChange: () => {} })).toThrow('Token not found');
    expect(FakeEventSource.instances).toEqual([]);
  });
});
