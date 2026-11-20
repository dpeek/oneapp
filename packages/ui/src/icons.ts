import type { HtmlBuilder } from "foldkit/html";

export const plusIcon = <Message>(h: HtmlBuilder<Message>, size: string) =>
  h.svg(
    [
      h.ViewBox("0 0 24 24"),
      h.Width(size),
      h.Height(size),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("2"),
      h.StrokeLinecap("round"),
      h.AriaHidden(true),
    ],
    [h.path([h.D("M12 5v14M5 12h14")], [])],
  );

export const ellipsisIcon = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [
      h.ViewBox("0 0 24 24"),
      h.Width("16"),
      h.Height("16"),
      h.Fill("currentColor"),
      h.AriaHidden(true),
    ],
    ["5", "12", "19"].map((x) =>
      h.circle([h.Cx(x), h.Cy("12"), h.R("1.5")], []),
    ),
  );
