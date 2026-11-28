import {
  backIcon,
  button,
  buttonClassName,
  outlineIcon,
  toolbar,
} from "@orumai/ui";
import { Effect, Schema, Stream } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

export const screenHeader = <Message>(
  props: {
    title?: string;
    attributes?: readonly Attribute<Message>[];
    navigation?: readonly Html[];
    controls?: readonly Html[];
    viewControls?: readonly Html[];
    endControls?: readonly Html[];
    viewControlsBelow?: boolean;
    primaryAction?: Html;
    feedback?: readonly Html[];
  },
  h: HtmlBuilder<Message>,
) => {
  const title = props.title
    ? h.h1([h.Title(props.title)], [props.title])
    : h.empty;
  return h.header(
    [
      h.Class("workspace-header workspace-screen-header"),
      h.Tabindex(-1),
      ...(props.attributes ?? []),
    ],
    [
      toolbar(
        {
          start: [
            ...(props.navigation ?? []),
            title,
            ...(props.controls ?? []),
          ],
          controls: props.viewControls,
          controlsAfterEnd: props.viewControlsBelow,
          end: [
            ...(props.endControls ?? []),
            ...(props.primaryAction ? [props.primaryAction] : []),
          ],
        },
        h,
      ),
      ...(props.feedback ?? []),
    ],
  );
};

export const screenHeaderBack = <Message>(
  props: { href: string; label: string },
  h: HtmlBuilder<Message>,
) =>
  h.a(
    [
      h.Href(props.href),
      h.Class(buttonClassName({ variant: "ghost", size: "icon-sm" })),
      h.DataAttribute("slot", "button"),
      h.AriaLabel(props.label),
      h.Title(props.label),
    ],
    [backIcon(h)],
  );

export const workspace = <Message>(
  props: {
    className: string;
    attributes?: readonly Attribute<Message>[];
    layout?: "stacked" | "split";
    header: Html;
    sidebar?: Html;
    list: Html;
    detail?: Html;
    hasSelection: boolean;
    sheet?: Html;
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class(
        `workspace ${props.className}${props.layout ? ` workspace-${props.layout}` : ""}`,
      ),
      ...(props.hasSelection ? [h.DataAttribute("panel", "")] : []),
      ...(props.attributes ?? []),
    ],
    [
      props.header,
      ...(props.sidebar
        ? [h.div([h.Class("workspace-sidebar")], [props.sidebar])]
        : []),
      props.list,
      ...(props.detail ? [props.detail] : []),
      ...(props.sheet ? [props.sheet] : []),
    ],
  );

export const workspaceDrawerMedia = "(max-width: 64rem)";

const workspaceSplitMedia = "(min-width: 72rem)";
const columnsIconPath =
  "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM12 3v18";
const listIconPath = "M3 6h18M3 12h12M3 18h18";

export const WorkspaceLayout = Schema.Struct({
  wide: Schema.Boolean,
  split: Schema.Boolean,
});

export const readWorkspaceLayout = (
  key: string,
): typeof WorkspaceLayout.Type => ({
  wide: matchMedia(workspaceSplitMedia).matches,
  split: Effect.try(() => localStorage.getItem(key) === "true").pipe(
    Effect.orElseSucceed(() => false),
    Effect.runSync,
  ),
});

export const watchWorkspaceWidth = () => {
  const media = matchMedia(workspaceSplitMedia);
  return Stream.fromEventListener<MediaQueryListEvent>(media, "change").pipe(
    Stream.map(({ matches }) => matches),
    Stream.prepend([media.matches]),
  );
};

export const workspaceLayoutButton = <Message>(
  layout: typeof WorkspaceLayout.Type,
  onClick: Message,
  h: HtmlBuilder<Message>,
) =>
  layout.wide
    ? button(
        {
          size: "icon-sm",
          variant: "ghost",
          ariaLabel: layout.split ? "Show list only" : "Show split view",
          onClick,
          children: [
            outlineIcon(h, [layout.split ? listIconPath : columnsIconPath]),
          ],
        },
        h,
      )
    : h.empty;
