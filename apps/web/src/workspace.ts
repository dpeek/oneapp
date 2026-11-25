import { backIcon, buttonClassName, toolbar } from "@oneapp/ui";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

export const screenHeader = <Message>(
  props: {
    title: string;
    navigation?: readonly Html[];
    controls?: readonly Html[];
    primaryAction?: Html;
    feedback?: readonly Html[];
  },
  h: HtmlBuilder<Message>,
) =>
  h.header(
    [h.Class("workspace-header workspace-screen-header"), h.Tabindex(-1)],
    [
      toolbar(
        {
          start: [
            ...(props.navigation ?? []),
            h.h1([h.Title(props.title)], [props.title]),
            ...(props.controls ?? []),
          ],
          end: props.primaryAction ? [props.primaryAction] : [],
        },
        h,
      ),
      ...(props.feedback ?? []),
    ],
  );

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
    title?: string;
    titleAccessory?: Html;
    header?: Html;
    headerAttributes?: ReadonlyArray<Attribute<Message>>;
    headerActions?: ReadonlyArray<Html>;
    sidebar?: Html;
    list: Html;
    detail?: Html;
    hasSelection: boolean;
    sheet?: Html;
  },
  h: HtmlBuilder<Message>,
): Html => {
  const title = props.title === undefined ? null : h.h1([], [props.title]);
  return h.div(
    [
      h.Class(`workspace ${props.className}`),
      ...(props.hasSelection ? [h.DataAttribute("panel", "")] : []),
    ],
    [
      props.header ??
        h.header(
          [h.Class("workspace-header"), ...(props.headerAttributes ?? [])],
          [
            ...(title
              ? [
                  props.titleAccessory
                    ? h.div(
                        [h.Class("workspace-heading")],
                        [title, props.titleAccessory],
                      )
                    : title,
                ]
              : []),
            ...(props.headerActions ?? []),
          ],
        ),
      ...(props.sidebar
        ? [h.div([h.Class("workspace-sidebar")], [props.sidebar])]
        : []),
      props.list,
      ...(props.detail ? [props.detail] : []),
      ...(props.sheet ? [props.sheet] : []),
    ],
  );
};

export const workspaceDrawerMedia = "(max-width: 64rem)";
