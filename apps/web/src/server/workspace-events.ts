import type {
  D1Database,
  WebSocket as CloudflareWebSocket,
} from "@cloudflare/workers-types";
import { taskRunnerScope } from "@orumai/core/cli-auth";
import {
  isTaskQueueChange,
  type WorkspaceChange,
} from "../workspace-change-contract.ts";
import { ownerId } from "./auth.ts";
import { hasCliScope } from "./cli-tokens.ts";

export const inboxSessionHeaders = {
  id: "x-oneapp-inbox-session-id",
  revision: "x-oneapp-inbox-security-revision",
  mailbox: "x-oneapp-inbox-mailbox",
};
export const runnerSocketTokenHeader = "x-oneapp-runner-token-id";

type InboxSocketSession = {
  sessionId: string;
  securityRevision: string;
  mailboxId: string;
};
type RunnerSocketSession = { runnerTokenId: string };
type SocketSession = InboxSocketSession | RunnerSocketSession;

export const socketSession = (headers: {
  get(name: string): string | null;
}): SocketSession | null => {
  const runnerTokenId = headers.get(runnerSocketTokenHeader);
  if (runnerTokenId) return { runnerTokenId };
  const sessionId = headers.get(inboxSessionHeaders.id);
  const securityRevision = headers.get(inboxSessionHeaders.revision);
  const mailboxId = headers.get(inboxSessionHeaders.mailbox);
  return sessionId && securityRevision && mailboxId
    ? { sessionId, securityRevision, mailboxId }
    : null;
};

const activeBrowserSessions = async (
  db: D1Database,
  sessions: InboxSocketSession[],
  now: number,
) => {
  const mailboxId = sessions[0]?.mailboxId;
  if (!mailboxId) return new Map<string, string>();
  const ids = new Set(sessions.map(({ sessionId }) => sessionId));
  const { results } = await db
    .prepare(
      `
    SELECT s.session_id AS sessionId, s.security_revision AS securityRevision
    FROM oneapp_auth_sessions s
    JOIN accounts a ON a.id = s.subject_id AND a.security_revision = s.security_revision
    JOIN mailboxes b ON b.owner_account_id = a.id
    WHERE b.id = ? AND a.active = 1
      AND s.expires_at > ? AND s.absolute_expires_at > ?
      AND s.session_id IN (SELECT value FROM json_each(?))
    `,
    )
    .bind(mailboxId, now, now, JSON.stringify([...ids]))
    .all<InboxSocketSession>();
  return new Map(
    results.map(({ sessionId, securityRevision }) => [
      sessionId,
      securityRevision,
    ]),
  );
};

const activeRunnerTokens = async (
  db: D1Database,
  ids: Set<string>,
  now: number,
) => {
  if (ids.size === 0) return new Set<string>();
  const { results } = await db
    .prepare(
      `
    SELECT t.id, t.scopes
    FROM cli_tokens t JOIN accounts a ON a.id = t.owner_id
    WHERE t.owner_id = ? AND a.active = 1
      AND (t.expires_at IS NULL OR t.expires_at > ?)
      AND t.id IN (SELECT value FROM json_each(?))
    `,
    )
    .bind(ownerId, now, JSON.stringify([...ids]))
    .all<{ id: string; scopes: string }>();
  return new Set(
    results
      .filter(({ scopes }) => hasCliScope(scopes, taskRunnerScope))
      .map(({ id }) => id),
  );
};

type WorkspaceSocket = Pick<
  CloudflareWebSocket,
  "readyState" | "deserializeAttachment" | "send" | "close"
>;

export const publishWorkspaceChange = async (
  db: D1Database,
  sockets: WorkspaceSocket[],
  change: WorkspaceChange,
) => {
  const taskQueueChange = isTaskQueueChange(change);
  const browserSessions: InboxSocketSession[] = [];
  const runnerIds = new Set<string>();
  const clients = sockets.flatMap((socket) => {
    if (socket.readyState !== WebSocket.OPEN) return [];
    const session = socket.deserializeAttachment() as SocketSession | null;
    if (session && "runnerTokenId" in session) {
      if (!taskQueueChange) return [];
      runnerIds.add(session.runnerTokenId);
    } else if (session) {
      browserSessions.push(session);
    }
    return [{ socket, session }];
  });
  if (clients.length === 0) return;

  // Recheck authorization before disclosing even the timing of an update.
  const now = Date.now();
  const [browser, runners] = await Promise.all([
    activeBrowserSessions(db, browserSessions, now),
    activeRunnerTokens(db, runnerIds, now),
  ]);
  for (const { socket, session } of clients) {
    const active =
      session &&
      ("runnerTokenId" in session
        ? runners.has(session.runnerTokenId)
        : session.mailboxId === browserSessions[0]?.mailboxId &&
          browser.get(session.sessionId) === session.securityRevision);
    try {
      if (active) socket.send(change);
      else socket.close(1008, "Session ended");
    } catch {
      // A peer can disconnect while the broadcast is in flight.
    }
  }
};
