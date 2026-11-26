import { Toast } from "@orumai/ui";
import { Effect } from "effect";
import { Mount } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { placeNotificationHost } from "./notification-host.ts";
import { Message, wrap, type Model } from "./notifications.ts";

const PlaceHost = Mount.define("PlaceNotificationHost", {
  messages: [Message.HostMounted],
  execute: ({ element }) =>
    Effect.gen(function* () {
      if (element instanceof HTMLElement) {
        yield* Effect.acquireRelease(
          Effect.sync(() => placeNotificationHost(element)),
          (cleanup) => Effect.sync(cleanup),
        );
      }
      return Message.HostMounted();
    }),
});

export const notificationView = <Parent>(
  model: Model,
  emit: (message: Message) => Parent,
  h: HtmlBuilder<Parent>,
) =>
  h.div(
    [h.Key("notification-anchor"), h.Class("notification-anchor")],
    [
      h.div(
        [
          h.Key("notification-host"),
          h.Class("notification-host"),
          h.OnMount(Mount.mapMessage(PlaceHost(), emit)),
        ],
        [
          Toast.toast(
            {
              model: model.toast,
              toParentMessage: (message) =>
                emit(wrap(model.generation)(message)),
            },
            h,
          ),
        ],
      ),
    ],
  );
