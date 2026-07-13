/**
 * The Crew Console root (ADR-0012, extended by ADR-0017), rebuilt to the Crew
 * Console design: a left sidebar over six views (Now, Overview, Agents,
 * Tasks, Messages, Operations), a light/dark theme toggle (FR-U38), a
 * quick-message modal opened by clicking an Agent (replacing the previous
 * "jump to Messages tab" flow), toasts, and a one-click confirm modal
 * (FR-U25, relaxed). It fetches the snapshot, health, and owned-session list
 * on mount and after each SSE change (no polling) and after each completed
 * action (never mid-form). All operator authority stays server-side; this
 * shell only drives the FR-U16–U18 enable logic and renders. Stored content
 * renders through Preact's default text escaping — never
 * dangerouslySetInnerHTML.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { fetchSnapshot, getToken, subscribeToChanges } from './api.js';
import { Agents } from './components/agents.js';
import { ConfirmDialog } from './components/confirm-dialog.js';
import type { HealthState } from './components/health.js';
import { MessageModal } from './components/message-modal.js';
import { MessagesView } from './components/messages-view.js';
import { NowView } from './components/now-view.js';
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
  assertNever,
  attentionItems,
  nowWorklist,
  OPERATOR_ID,
  reviewQueue,
  shortId,
  unreadCount,
} from './view-model.js';

/** Bounded, stored-content-free failure line (the cause stays in devtools). */
const FETCH_ERROR = 'snapshot fetch failed — the crew ui server may have stopped';

/** FR-U38: local-only theme preference, never sent to the server. */
const THEME_STORAGE_KEY = 'crew-console-theme';
type Theme = 'light' | 'dark';

function loadTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function saveTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable (private browsing, quota); the toggle still
    // works for the session, it just won't persist across reloads.
  }
}

/** A pending destructive action awaiting its one-click confirmation (FR-U25). */
type DestructiveAction =
  | { readonly kind: 'stop'; readonly session: string }
  | { readonly kind: 'prune' }
  | { readonly kind: 'clean' }
  | { readonly kind: 'archive'; readonly agentId: string };

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
  now: ['Now', 'What needs you — in priority order'],
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
  archive: [
    'Archive agent',
    'Archiving hides it from the active roster and its lease/messages stay intact. You can restore it later.',
    'Archive agent',
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
  const [view, setView] = useState<ViewId>('now');
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draftRecipient, setDraftRecipient] = useState('');
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const [confirm, setConfirm] = useState<DestructiveAction | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [msgModal, setMsgModal] = useState<{ readonly to: string } | null>(null);
  const [msgModalText, setMsgModalText] = useState('');
  const [msgModalPending, setMsgModalPending] = useState(false);
  const [msgModalError, setMsgModalError] = useState<string | null>(null);

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

  // FR-U38: apply the theme to the document root before paint and persist it
  // — a pure presentation preference, never sent to the server.
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    saveTheme(theme);
  }, [theme]);

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

  /** Opens the quick-message modal pre-addressed to `id` (replaces the old jump-to-Messages flow). */
  function messageAgent(id: string): void {
    setMsgModal({ to: id });
    setMsgModalText('');
    setMsgModalError(null);
  }

  // Stable identity for the same reason as cancelConfirm above: MessageModal's
  // document-keydown effect depends on this, and the App re-renders on every
  // SSE refetch tick while the modal is open.
  const closeMsgModal = useCallback((): void => {
    setMsgModal(null);
    setMsgModalText('');
    setMsgModalError(null);
  }, []);

  /** Selects a Task and switches to the Tasks view — the Now worklist's task-item action. */
  function goToTask(taskId: string): void {
    setSelectedTaskId(taskId);
    setView('tasks');
  }

  async function sendMessage(input: { recipient: string; content: string }): Promise<void> {
    await postAction('/api/messages', { to: input.recipient, content: input.content });
    pushToast('Message sent', `to ${input.recipient}`, '#2f7de0');
    await refetch();
  }

  async function sendModalMessage(): Promise<void> {
    const modal = msgModal;
    if (modal === null) return;
    const content = msgModalText.trim();
    if (content === '') {
      setMsgModalError('Message is empty.');
      return;
    }
    setMsgModalPending(true);
    setMsgModalError(null);
    try {
      await sendMessage({ recipient: modal.to, content });
      setMsgModal(null);
      setMsgModalText('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Send failed';
      // A toast survives the modal closing (Escape/backdrop/× are not
      // gated by `pending`), so a failed send is never silently lost.
      pushToast('Message not sent', message, '#d15540');
      setMsgModalError(message);
    } finally {
      setMsgModalPending(false);
    }
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

  /** `POST /api/agents/:id/restore` — reversible, no confirmation (FR-U36). */
  async function restoreAgent(id: string): Promise<void> {
    try {
      await postAction(`/api/agents/${encodeURIComponent(id)}/restore`, {});
      pushToast(`Restored ${id}`, 'Back on the roster', '#27a05f');
      await refetch();
    } catch (err) {
      pushToast('Restore failed', err instanceof Error ? err.message : 'Restore failed', '#d15540');
    }
  }

  async function runConfirmed(action: DestructiveAction): Promise<void> {
    switch (action.kind) {
      case 'stop':
        await postAction('/api/team/stop', { session: action.session, confirm: true });
        pushToast('Session stopped', action.session, '#d15540');
        return;
      case 'prune':
        await postAction('/api/prune', { confirm: true });
        pushToast('Prune complete', 'old history removed', '#8b95a3');
        return;
      case 'clean':
        await postAction('/api/clean', { confirm: true });
        pushToast('Clean complete', 'State Store removed', '#d15540');
        return;
      case 'archive':
        await postAction(`/api/agents/${encodeURIComponent(action.agentId)}/archive`, {
          confirm: true,
        });
        pushToast(`Archived ${action.agentId}`, 'Hidden from the active roster', '#d15540');
        return;
      default:
        assertNever(action);
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
  const dark = theme === 'dark';
  const attention = attentionItems(snapshot.tasks, snapshot.agents, now);
  const queue = reviewQueue(snapshot.tasks);
  const unread = unreadCount(snapshot.messages);
  const worklist = nowWorklist(snapshot.tasks, snapshot.agents, snapshot.messages, now);
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
        workCount={worklist.length}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              class="theme-toggle"
              title="Toggle light / dark"
              aria-pressed={dark}
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 18 18"
                fill="none"
                stroke={dark ? 'var(--faint)' : '#d99a2b'}
                stroke-width="1.6"
              >
                <circle cx="9" cy="9" r="3.5" />
                <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" />
              </svg>
              <span class={`theme-toggle-track${dark ? ' dark' : ''}`}>
                <span class="theme-toggle-knob" />
              </span>
              <svg
                width="15"
                height="15"
                viewBox="0 0 18 18"
                fill="none"
                stroke={dark ? ACCENT : 'var(--faint)'}
                stroke-width="1.6"
              >
                <path d="M15 10.5A6.5 6.5 0 0 1 7.5 3a6.5 6.5 0 1 0 7.5 7.5Z" />
              </svg>
            </button>
            <div class="topstat">
              <span class="dot" />
              {snapshot.agents.length} agents · {attention.length} need attention
            </div>
          </div>
        </header>

        <div class="view">
          {error !== null && (
            <p class="error-line" role="alert">
              {error}
            </p>
          )}
          <RecoveryBanner visible={recovering} />

          {view === 'now' && (
            <NowView
              items={worklist}
              dark={dark}
              onSelectTask={goToTask}
              onMessageAgent={messageAgent}
              onOpenMessages={() => setView('messages')}
            />
          )}
          {view === 'overview' && (
            <Overview
              agents={snapshot.agents}
              tasks={snapshot.tasks}
              health={health}
              now={now}
              dark={dark}
              onMessageAgent={messageAgent}
              onGoAgents={() => setView('agents')}
            />
          )}
          {view === 'agents' && (
            <Agents
              agents={snapshot.agents}
              tasks={snapshot.tasks}
              now={now}
              dark={dark}
              disabled={recovering}
              onMessageAgent={messageAgent}
              onArchiveAgent={(id) => {
                setConfirmError(null);
                setConfirm({ kind: 'archive', agentId: id });
              }}
              onRestoreAgent={(id) => void restoreAgent(id)}
            />
          )}
          {view === 'tasks' && (
            <TasksView
              tasks={snapshot.tasks}
              selectedId={selectedTaskId}
              now={now}
              dark={dark}
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
              dark={dark}
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
              dark={dark}
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

      <MessageModal
        to={msgModal?.to ?? null}
        text={msgModalText}
        pending={msgModalPending}
        error={msgModalError}
        onTextChange={setMsgModalText}
        onClose={closeMsgModal}
        onSend={() => void sendModalMessage()}
      />

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
