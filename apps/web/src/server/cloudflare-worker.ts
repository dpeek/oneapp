import type {
  D1Database,
  Request as CloudflareRequest,
  WebSocket as CloudflareWebSocket,
} from "@cloudflare/workers-types";
import photonModule from "@cf-wasm/photon/photon.wasm";
import resvgModule from "@resvg/resvg-wasm/index_bg.wasm";
import { DurableObject } from "cloudflare:workers";
import { inboxChanged } from "../inbox-contract.ts";
import type { WorkspaceChange } from "../workspace-change-contract.ts";

import { createCompanyAvatarRenderer } from "./bitwarden/company-avatar-image.ts";
import { createSvgRasterizer } from "./bitwarden/website-icon-svg.ts";
import worker from "./worker.ts";
import { publishWorkspaceChange, socketSession } from "./workspace-events.ts";

const rasterizeSvg = createSvgRasterizer(resvgModule);
const renderCompanyAvatar = createCompanyAvatarRenderer(photonModule);

export default {
  ...worker,
  fetch: ((request, env, context) =>
    worker.fetch(
      request,
      env,
      context,
      rasterizeSvg,
      renderCompanyAvatar,
    )) satisfies typeof worker.fetch,
};

declare const WebSocketPair: typeof import("@cloudflare/workers-types").WebSocketPair;
declare const Response: typeof import("@cloudflare/workers-types").Response;

export class InboxUpdates extends DurableObject<{ DB: D1Database }> {
  fetch(request: CloudflareRequest) {
    const session = socketSession(request.headers);
    if (!session) return new Response(null, { status: 403 });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(session);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async publish(change: WorkspaceChange = inboxChanged) {
    await publishWorkspaceChange(this.env.DB, this.ctx.getWebSockets(), change);
  }

  webSocketMessage(socket: CloudflareWebSocket) {
    socket.close(1003, "Notifications only");
  }
}
