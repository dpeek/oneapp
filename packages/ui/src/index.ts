import { appName } from "@oneapp/core";
import { Schema } from "effect";
import { Runtime } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";

export { avatar } from "./avatar.ts";
export { avatarGroup } from "./avatar-group.ts";
export { button, buttonClassName } from "./button.ts";
export { buttonGroup } from "./button-group.ts";
export { dialog } from "./dialog.ts";
export * as DropdownMenu from "./dropdown-menu.ts";
export { field, input, textarea } from "./field.ts";
export { ellipsisIcon, plusIcon } from "./icons.ts";
export { item, itemDisclosure, itemGroup } from "./item.ts";
export { marker } from "./marker.ts";
export { navigationLinks, unreadBadge } from "./navigation.ts";
export * as Sheet from "./sheet.ts";
export { spinner } from "./spinner.ts";
export * as Tooltip from "./tooltip.ts";
export { timestamp } from "./timestamp.ts";

const Model = Schema.Struct({ title: Schema.String });
type Model = typeof Model.Type;

const init: Runtime.ApplicationInit<Model, never> = () => ({
  model: { title: appName },
});

const view = (model: Model, h: HtmlBuilder<never>): Document => ({
  title: model.title,
  body: h.main([], [h.h1([], [model.title])]),
});

export function mountOneApp(container: HTMLElement) {
  Runtime.run(
    Runtime.makeApplication({
      Model,
      init,
      update: (model) => ({ model }),
      view,
      container,
    }),
  );
}
