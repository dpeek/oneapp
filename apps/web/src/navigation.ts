import type { HtmlBuilder } from "foldkit/html";

const destinations = [
  {
    page: "links",
    label: "Links",
    paths: [
      "M10 13a4 4 0 0 0 6 .4l4-4a4 4 0 0 0-5.7-5.7L12 6",
      "M14 11a4 4 0 0 0-6-.4l-4 4a4 4 0 0 0 5.7 5.7L12 18",
    ],
  },
  {
    page: "settings",
    label: "Settings",
    paths: [
      "M12 8.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Z",
      "M10 3h4l.6 2.3 1.6.9 2.3-.6 2 3.5-1.7 1.7v2.4l1.7 1.7-2 3.5-2.3-.6-1.6.9L14 21h-4l-.6-2.3-1.6-.9-2.3.6-2-3.5 1.7-1.7v-2.4L3.5 9.1l2-3.5 2.3.6 1.6-.9L10 3Z",
    ],
  },
] as const;

export const navigationView = <Message>(
  page: (typeof destinations)[number]["page"],
  h: HtmlBuilder<Message>,
) =>
  h.nav(
    [h.Class("app-nav"), h.AriaLabel("Main navigation")],
    destinations.map((destination) =>
      h.a(
        [
          h.Class("app-nav-link"),
          h.Href(`/${destination.page}`),
          h.AriaLabel(destination.label),
          ...(page === destination.page ? [h.AriaCurrent("page")] : []),
        ],
        [
          h.svg(
            [
              h.ViewBox("0 0 24 24"),
              h.Fill("none"),
              h.Stroke("currentColor"),
              h.StrokeWidth("1.75"),
              h.StrokeLinecap("round"),
              h.StrokeLinejoin("round"),
              h.AriaHidden(true),
            ],
            destination.paths.map((path) => h.path([h.D(path)], [])),
          ),
          h.span(
            [h.Class("app-nav-tooltip"), h.AriaHidden(true)],
            [destination.label],
          ),
        ],
      ),
    ),
  );
