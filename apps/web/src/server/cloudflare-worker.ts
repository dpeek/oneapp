import type {
  D1Database,
  Request as CloudflareRequest,
  WebSocket as CloudflareWebSocket,
} from "@cloudflare/workers-types";
import resvgModule from "@resvg/resvg-wasm/index_bg.wasm";
import { DurableObject } from "cloudflare:workers";
import { inboxChanged } from "../inbox-contract.ts";

import { createSvgRasterizer } from "./bitwarden/website-icon-svg.ts";
import { inboxSessionHeaders, type InboxSocketSession } from "./inbox.ts";
import worker from "./worker.ts";

const rasterizeSvg = createSvgRasterizer(resvgModule);

export default {
  ...worker,
  fetch: ((request, env, context) =>
    worker.fetch(
      request,
      env,
      context,
      rasterizeSvg,
    )) satisfies typeof worker.fetch,
};

declare const WebSocketPair: typeof import("@cloudflare/workers-types").WebSocketPair;
declare const Response: typeof import("@cloudflare/workers-types").Response;

export class InboxUpdates extends DurableObject<{ DB: D1Database }> {
  fetch(request: CloudflareRequest) {
    const sessionId = request.headers.get(inboxSessionHeaders.id);
    const revision = request.headers.get(inboxSessionHeaders.revision);
    const mailboxId = request.headers.get(inboxSessionHeaders.mailbox);
    if (!sessionId || !revision || !mailboxId)
      return new Response(null, { status: 403 });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      sessionId,
      mailboxId,
      securityRevision: revision,
    } satisfies InboxSocketSession);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async publish() {
    const clients = this.ctx.getWebSockets().map((socket) => ({
      socket,
      session: socket.deserializeAttachment() as InboxSocketSession | null,
    }));
    if (clients.length === 0) return;

    const sessionIds = new Set(
      clients.flatMap(({ session }) => (session ? [session.sessionId] : [])),
    );
    const mailboxId = clients[0]?.session?.mailboxId ?? "";
    const now = Date.now();
    // Check the current session before disclosing even the timing of new mail.
    const { results } = await this.env.DB.prepare(
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
      .bind(mailboxId, now, now, JSON.stringify([...sessionIds]))
      .all<InboxSocketSession>();
    const active = new Map(
      results.map(({ sessionId, securityRevision }) => [
        sessionId,
        securityRevision,
      ]),
    );

    for (const { socket, session } of clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        if (
          session &&
          session.mailboxId === mailboxId &&
          active.get(session.sessionId) === session.securityRevision
        )
          socket.send(inboxChanged);
        else socket.close(1008, "Session ended");
      } catch {
        // A peer can disconnect while the broadcast is in flight.
      }
    }
  }

  webSocketMessage(socket: CloudflareWebSocket) {
    socket.close(1003, "Notifications only");
  }
}
