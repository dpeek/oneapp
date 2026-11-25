import { backIcon, buttonClassName, toolbar } from "@oneapp/ui";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

export const screenHeader = <Message>(
  props: {
    title: string;
    titleDetail?: Html;
    attributes?: readonly Attribute<Message>[];
    navigation?: readonly Html[];
    controls?: readonly Html[];
    viewControls?: readonly Html[];
    primaryAction?: Html;
    feedback?: readonly Html[];
  },
  h: HtmlBuilder<Message>,
) => {
  const title = h.h1([h.Title(props.title)], [props.title]);
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
            props.titleDetail
              ? h.div(
                  [h.Class("workspace-screen-heading")],
                  [title, props.titleDetail],
                )
              : title,
            ...(props.controls ?? []),
          ],
          controls: props.viewControls,
          end: props.primaryAction ? [props.primaryAction] : [],
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
      h.Class(
        buttonClassName({ variant: "ghost", size: "icon-sm", rounded: true }),
      ),
      h.DataAttribute("slot", "button"),
      h.AriaLabel(props.label),
      h.Title(props.label),
    ],
    [backIcon(h)],
  );

export const workspace = <Message>(
  props: {
    className: string;
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
      h.Class(`workspace ${props.className}`),
      ...(props.hasSelection ? [h.DataAttribute("panel", "")] : []),
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
