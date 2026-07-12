/**
 * The Crew Console root (ADR-0012), rebuilt to the Crew Console design: a left
 * sidebar over five views (Overview, Agents, Tasks, Messages, Operations), with
 * toasts and a one-click confirm modal (FR-U25, relaxed). It fetches the
 * snapshot, health, and owned-session list on mount and after each SSE change
 * (no polling) and after each completed action (never mid-form). All operator
 * authority stays server-side; this shell only drives the FR-U16–U18 enable
 * logic and renders. Stored content renders through Preact's default text
 * escaping — never dangerouslySetInnerHTML.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { fetchSnapshot, getToken, subscribeToChanges } from './api.js';
import { Agents } from './components/agents.js';
import { ConfirmDialog } from './components/confirm-dialog.js';
import type { HealthState } from './components/health.js';
import { MessagesView } from './components/messages-view.js';
import { Operations } from './components/operations.js';
import { Overview } from './components/overview.js';
import { RecoveryBanner } from './components/recovery-banner.js';
import { Sidebar, type ViewId } from './components/sidebar.js';
import { TasksView } from './components/tasks-view.js';
import { Toasts, type Toast } from './components/toasts.js';
import type {
  ResumableSessionSnapshotRecord,
  SessionSnapshotRecord,
  WorkspaceSnapshot,
} from './types.js';
import {
  ACCENT,
  attentionItems,
  OPERATOR_ID,
  reviewQueue,
  shortId,
  unreadCount,
} from './view-model.js';

/** Bounded, stored-content-free failure line (the cause stays in devtools). */
const FETCH_ERROR = 'snapshot fetch failed — the crew ui server may have stopped';

/** A pending destructive action awaiting its one-click confirmation (FR-U25). */
type DestructiveAction =
  | { readonly kind: 'stop'; readonly session: string }
  | { readonly kind: 'prune' }
  | { readonly kind: 'clean' };

interface ErrorEnvelope {
  readonly error?: { readonly code?: string; readonly message?: string };
}

/** POST one Console action; throws a bounded envelope-derived Error on failure. */
async function postAction(path: string, body: Record<string, unknown>): Promise<void> {
  const token = getToken();
  if (!token) throw new Error('Token not found in URL. Please reload the page.');
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const envelope = (await response.json().catch(() => ({}))) as ErrorEnvelope;
    throw new Error(envelope.error?.message ?? `request failed (${response.status})`);
  }
}

/** GET /api/health with the page token. */
async function fetchHealth(): Promise<HealthState> {
  const token = getToken();
  if (!token) throw new Error('Token not found in URL. Please reload the page.');
  const response = await fetch(`/api/health?token=${encodeURIComponent(token)}`);
  if (!response.ok) throw new Error(`Health request failed: ${response.status}`);
  return (await response.json()) as HealthState;
}

/** GET /api/sessions with the page token; returns the live owned-session list. */
async function fetchSessions(): Promise<readonly SessionSnapshotRecord[]> {
  const token = getToken();
  if (!token) throw new Error('Token not found in URL. Please reload the page.');
  const response = await fetch(`/api/sessions?token=${encodeURIComponent(token)}`);
  if (!response.ok) throw new Error(`Sessions request failed: ${response.status}`);
  const body = (await response.json()) as { sessions?: readonly SessionSnapshotRecord[] };
  return body.sessions ?? [];
}

/** GET /api/resumable-sessions with the page token; returns stopped sessions that can be resumed. */
async function fetchResumableSessions(): Promise<readonly ResumableSessionSnapshotRecord[]> {
  const token = getToken();
  if (!token) throw new Error('Token not found in URL. Please reload the page.');
  const response = await fetch(`/api/resumable-sessions?token=${encodeURIComponent(token)}`);
  if (!response.ok) throw new Error(`Resumable sessions request failed: ${response.status}`);
  const body = (await response.json()) as {
    resumable_sessions?: readonly ResumableSessionSnapshotRecord[];
  };
  return body.resumable_sessions ?? [];
}

const TITLES: Record<ViewId, readonly [string, string]> = {
  overview: ['Overview', 'Everything at a glance across the crew'],
  agents: ['Agents', 'The roster and what each agent is doing'],
  tasks: ['Tasks', 'The reviewed work board — approve, requeue, reassign'],
  messages: ['Messages', 'Coordinate agents from the operator inbox'],
  operations: ['Operations', 'Teams, health and workspace maintenance'],
};

const CONFIRM_TEXT: Record<DestructiveAction['kind'], readonly [string, string, string]> = {
  stop: [
    'Stop session',
    'Stopping kills the tmux session — irreversible for in-flight pane state.',
    'Stop session',
  ],
  prune: [
    'Prune workspace history',
    'Prune permanently deletes old read messages and finished tasks. This cannot be undone.',
    'Prune',
  ],
  clean: [
    'Remove the State Store',
    'Clean removes the State Store files and stops this Console. This cannot be undone.',
    'Clean',
  ],
};

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [health, setHealth] = useState<HealthState | null>(null);
  const [sessions, setSessions] = useState<readonly SessionSnapshotRecord[]>([]);
  const [resumableSessions, setResumableSessions] = useState<
    readonly ResumableSessionSnapshotRecord[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>('overview');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draftRecipient, setDraftRecipient] = useState('');
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const [confirm, setConfirm] = useState<DestructiveAction | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

  const recoveringRef = useRef(false);
  const disposedRef = useRef(false);
  const toastSeq = useRef(100);

  const pushToast = useCallback((title: string, detail: string, dot: string): void => {
    const id = ++toastSeq.current;
    setToasts((current) => [...current, { id, title, detail, dot }]);
    setTimeout(() => {
      if (!disposedRef.current) setToasts((current) => current.filter((t) => t.id !== id));
    }, 3800);
  }, []);

  // Stable identity so the ConfirmDialog's document-keydown effect does not
  // re-subscribe on every unrelated App re-render (e.g. an SSE refetch).
  const cancelConfirm = useCallback((): void => {
    setConfirm(null);
    setConfirmError(null);
  }, []);

  const refetch = useCallback(async (): Promise<void> => {
    if (recoveringRef.current) return;
    try {
      const [nextSnapshot, nextHealth, nextSessions, nextResumableSessions] = await Promise.all([
        fetchSnapshot(),
        fetchHealth(),
        fetchSessions().catch(() => [] as readonly SessionSnapshotRecord[]),
        fetchResumableSessions().catch(() => [] as readonly ResumableSessionSnapshotRecord[]),
      ]);
      if (disposedRef.current) return;
      setSnapshot(nextSnapshot);
      setHealth(nextHealth);
      setSessions(nextSessions);
      setResumableSessions(nextResumableSessions);
      setError(null);
    } catch {
      if (!disposedRef.current) setError(FETCH_ERROR);
    }
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    void refetch();
    const subscription = subscribeToChanges({
      onChange: () => {
        recoveringRef.current = false;
        setRecovering(false);
        void refetch();
      },
      onWorkspaceMissing: () => {
        recoveringRef.current = true;
        setRecovering(true);
      },
      onWorkspaceRestored: () => {
        recoveringRef.current = false;
        setRecovering(false);
        void refetch();
      },
    });
    return () => {
      disposedRef.current = true;
      subscription.close();
    };
  }, [refetch]);

  function messageAgent(id: string): void {
    setDraftRecipient(id);
    setView('messages');
  }

  async function sendMessage(input: { recipient: string; content: string }): Promise<void> {
    await postAction('/api/messages', { to: input.recipient, content: input.content });
    pushToast('Message sent', `to ${input.recipient}`, '#2f7de0');
    await refetch();
  }

  async function approveTask(taskId: string): Promise<void> {
    await postAction(`/api/tasks/${encodeURIComponent(taskId)}/approve`, {});
    pushToast(`Approved ${shortId(taskId)}`, 'task completed', '#27a05f');
    await refetch();
  }

  async function requeueTask(
    taskId: string,
    input: { reason: string; to?: string },
  ): Promise<void> {
    await postAction(`/api/tasks/${encodeURIComponent(taskId)}/requeue`, { ...input });
    pushToast(
      `Requeued ${shortId(taskId)}`,
      input.to ? `reassigned to ${input.to}` : '',
      '#8b95a3',
    );
    await refetch();
  }

  async function launchTeam(team: string): Promise<void> {
    await postAction('/api/team/launch', { team });
    pushToast('Team launched', `${team} · detached`, '#27a05f');
    await refetch();
  }

  async function resumeTeam(session: string): Promise<void> {
    await postAction('/api/team/resume', { session });
    pushToast('Session resumed', session, '#27a05f');
    await refetch();
  }

  async function runConfirmed(action: DestructiveAction): Promise<void> {
    if (action.kind === 'stop') {
      await postAction('/api/team/stop', { session: action.session, confirm: true });
      pushToast('Session stopped', action.session, '#d15540');
    } else if (action.kind === 'prune') {
      await postAction('/api/prune', { confirm: true });
      pushToast('Prune complete', 'old history removed', '#8b95a3');
    } else {
      await postAction('/api/clean', { confirm: true });
      pushToast('Clean complete', 'State Store removed', '#d15540');
    }
  }

  async function acceptConfirm(): Promise<void> {
    const action = confirm;
    if (action === null) return;
    setConfirmPending(true);
    setConfirmError(null);
    try {
      await runConfirmed(action);
      setConfirm(null);
      await refetch();
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setConfirmPending(false);
    }
  }

  if (snapshot === null) {
    return (
      <div class="boot" role="status" aria-live="polite">
        {error === null ? (
          <>
            <span class="boot-mark" aria-hidden="true" />
            <p>Reading the workspace…</p>
          </>
        ) : (
          <p class="error-line" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const now = Date.now();
  const attention = attentionItems(snapshot.tasks, snapshot.agents, now);
  const queue = reviewQueue(snapshot.tasks);
  const unread = unreadCount(snapshot.messages);
  const recipientOptions = snapshot.agents.map((a) => ({ id: a.id, label: `${a.id} · ${a.role}` }));
  const roleOf = (id: string): string =>
    snapshot.agents.find((a) => a.id === id)?.role ?? (id === OPERATOR_ID ? 'operator' : 'worker');
  const [title, subtitle] = TITLES[view];
  const confirmText = confirm === null ? null : CONFIRM_TEXT[confirm.kind];

  return (
    <div class="console" style={{ '--accent': ACCENT }}>
      <Sidebar
        view={view}
        onNavigate={(next) => {
          setConfirmError(null);
          setView(next);
        }}
        agentCount={snapshot.agents.length}
        reviewCount={queue.length}
        unreadCount={unread}
        needsAttention={attention.length > 0}
        workspaceLabel={health?.summary.workspace ?? '~/workspace'}
      />

      {/* The confirm dialog's focus-restore fallback: when the
          trigger is disabled/unmounted after a confirmed destructive action,
          focus lands here instead of dropping to <body>. */}
      <main class="main" tabIndex={-1} data-focus-fallback>
        <header class="topbar">
          <div>
            <h1>{title}</h1>
            <p class="subtitle">{subtitle}</p>
          </div>
          <div class="topstat">
            <span class="dot" />
            {snapshot.agents.length} agents · {attention.length} need attention
          </div>
        </header>

        <div class="view">
          {error !== null && (
            <p class="error-line" role="alert">
              {error}
            </p>
          )}
          <RecoveryBanner visible={recovering} />

          {view === 'overview' && (
            <Overview
              agents={snapshot.agents}
              tasks={snapshot.tasks}
              health={health}
              now={now}
              onMessageAgent={messageAgent}
              onGoAgents={() => setView('agents')}
            />
          )}
          {view === 'agents' && (
            <Agents
              agents={snapshot.agents}
              tasks={snapshot.tasks}
              now={now}
              onMessageAgent={messageAgent}
            />
          )}
          {view === 'tasks' && (
            <TasksView
              tasks={snapshot.tasks}
              selectedId={selectedTaskId}
              now={now}
              disabled={recovering}
              recipientOptions={recipientOptions}
              onSelect={setSelectedTaskId}
              onApprove={approveTask}
              onRequeue={requeueTask}
            />
          )}
          {view === 'messages' && (
            <MessagesView
              messages={snapshot.messages}
              recipientOptions={recipientOptions}
              recipient={draftRecipient}
              now={now}
              disabled={recovering}
              roleOf={roleOf}
              onRecipientChange={setDraftRecipient}
              onSend={sendMessage}
            />
          )}
          {view === 'operations' && (
            <Operations
              sessions={sessions}
              resumableSessions={resumableSessions}
              health={health}
              now={now}
              disabled={recovering}
              onLaunch={launchTeam}
              onRequestResume={resumeTeam}
              onRequestStop={(session) => {
                setConfirmError(null);
                setConfirm({ kind: 'stop', session });
              }}
              onRequestPrune={() => {
                setConfirmError(null);
                setConfirm({ kind: 'prune' });
              }}
              onRequestClean={() => {
                setConfirmError(null);
                setConfirm({ kind: 'clean' });
              }}
            />
          )}
        </div>
      </main>

      <Toasts toasts={toasts} />

      <ConfirmDialog
        open={confirm !== null}
        title={confirmText?.[0] ?? ''}
        description={confirmText?.[1] ?? ''}
        confirmLabel={confirmText?.[2] ?? 'Confirm'}
        pending={confirmPending}
        error={confirmError}
        onConfirm={() => void acceptConfirm()}
        onCancel={cancelConfirm}
      />
    </div>
  );
}
