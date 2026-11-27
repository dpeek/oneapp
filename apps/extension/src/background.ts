import { defaultServerUrl } from "@orumai/core";
import {
  digestSecret,
  ExtensionRequestId,
  ExtensionScope,
} from "@orumai/core/extension-auth";
import { Schema } from "effect";
import { readConnection } from "./access.ts";

const ApprovalMessage = Schema.Struct({
  type: Schema.Literal("approve-oneapp-extension"),
  id: ExtensionRequestId,
  scope: Schema.optionalKey(ExtensionScope),
});
const isApprovalMessage = Schema.is(ApprovalMessage);

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  if (
    sender.origin !== defaultServerUrl ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !isApprovalMessage(message)
  )
    return;

  const tabId = sender.tab.id;
  const readApproval = async () => {
    const scope = message.scope ?? "links";
    const connection = await readConnection(scope);
    if (
      connection?.id !== message.id ||
      connection.approvalTab !== tabId ||
      connection.pendingUntil <= Date.now()
    )
      return null;
    return {
      id: connection.id,
      digest: await digestSecret(connection.secret),
      scope,
    };
  };
  void readApproval().then(respond, () => respond(null));
  return true;
});
