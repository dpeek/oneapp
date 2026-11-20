import type { Html, HtmlBuilder } from "foldkit/html";

export const workspace = <Message>(
  props: {
    className: string;
    title?: string;
    titleAccessory?: Html;
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
      h.header(
        [h.Class("workspace-header")],
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
