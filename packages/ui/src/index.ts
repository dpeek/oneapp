import { appName } from "@orumai/core";
import { Schema } from "effect";
import { Runtime } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";

export { avatar, createAvatar } from "./avatar.ts";
export { actionBar } from "./action-bar.ts";
export {
  alert,
  createAlert,
  type AlertAnnouncement,
  type AlertSeverity,
} from "./alert.ts";
export { avatarGroup } from "./avatar-group.ts";
export { badge } from "./badge.ts";
export { button, buttonClassName } from "./button.ts";
export { buttonGroup, createButtonGroup } from "./button-group.ts";
export * as CalendarPicker from "./calendar-picker.ts";
export { checkbox } from "./checkbox.ts";
export * as ColorPicker from "./color-picker.ts";
export * as CommandMenu from "./command-menu.ts";
export * as Dialog from "./dialog.ts";
export * as DropdownMenu from "./dropdown-menu.ts";
export { empty } from "./empty.ts";
export {
  createField,
  createFieldGroup,
  field,
  fieldClassNames,
  input,
  inputClassName,
  inputGroupControlClassName,
  textarea,
} from "./field.ts";
export { createFileInput, fileInput } from "./file-input.ts";
export {
  backIcon,
  calendarIconPaths,
  circleCheckIconPaths,
  circleDashedIconPaths,
  circleDotDashedIconPaths,
  circleXIconPaths,
  clockIconPaths,
  ellipsisIcon,
  filesIconPaths,
  flameIconPaths,
  linkIconPaths,
  mailIconPaths,
  noiseIconPath,
  outlineIcon,
  plusIcon,
  signalHighIconPaths,
  signalLowIconPaths,
  signalMediumIconPaths,
  taskIconPaths,
  trashIconPaths,
  userCheckIconPaths,
} from "./icons.ts";
export { createInputGroup } from "./input-group.ts";
export {
  item,
  itemClassName,
  itemClassNames,
  itemDisclosure,
  itemGroup,
} from "./item.ts";
export { marker } from "./marker.ts";
export * as MultiCombobox from "./multi-combobox.ts";
export { createNativeSelect, nativeSelect } from "./native-select.ts";
export {
  navigationLinks,
  sidebarClassNames,
  sidebarItemClassName,
  unreadBadge,
} from "./navigation.ts";
export * as Popover from "./popover.ts";
export * as Sheet from "./sheet.ts";
export { skeleton } from "./skeleton.ts";
export { spinner } from "./spinner.ts";
export { visuallyHiddenStatus } from "./status.ts";
export { toolbar } from "./toolbar.ts";
export * as Tooltip from "./tooltip.ts";
export * as Toast from "./toast.ts";
export * as Tokenizer from "./tokenizer.ts";
export { timestamp } from "./timestamp.ts";
export { viewToggleGroup } from "./view-switch.ts";

const Model = Schema.Struct({ title: Schema.String });
type Model = typeof Model.Type;

const init: Runtime.ApplicationInit<Model, never> = () => ({
  model: { title: appName },
});

const view = (model: Model, h: HtmlBuilder<never>): Document => ({
  title: model.title,
  body: h.main([], [h.h1([], [model.title])]),
});

export function mountOrumai(container: HTMLElement) {
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
