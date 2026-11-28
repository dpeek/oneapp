import type { HtmlBuilder } from "foldkit/html";

export const noiseIconPath = "M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4";

export const linkIconPaths = [
  "M10 13a4 4 0 0 0 6 .4l4-4a4 4 0 0 0-5.7-5.7L12 6",
  "M14 11a4 4 0 0 0-6-.4l-4 4a4 4 0 0 0 5.7 5.7L12 18",
] as const;

export const mailIconPaths = [
  "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  "m3 7 9 6 9-6",
] as const;

export const calendarIconPaths = [
  "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  "M3 10h18M8 3v4m8-4v4m-8 8h2m4 0h2",
] as const;

export const taskIconPaths = [
  "m3 7 2 2 4-4m2 3h10",
  "m3 16 2 2 4-4m2 3h10",
] as const;

export const cloudIconPaths = [
  "M6 18a4 4 0 1 1 .7-7.94A6 6 0 0 1 18.46 11H19a3.5 3.5 0 0 1 0 7Z",
] as const;

// Lucide icons. See THIRD_PARTY_NOTICES.md.
const circleIconPath = "M22 12a10 10 0 1 0-20 0 10 10 0 1 0 20 0Z";
export const circleDashedIconPaths = [
  "M10.1 2.182a10 10 0 0 1 3.8 0",
  "M13.9 21.818a10 10 0 0 1-3.8 0",
  "M17.609 3.721a10 10 0 0 1 2.69 2.7",
  "M2.182 13.9a10 10 0 0 1 0-3.8",
  "M20.279 17.609a10 10 0 0 1-2.7 2.69",
  "M21.818 10.1a10 10 0 0 1 0 3.8",
  "M3.721 6.391a10 10 0 0 1 2.7-2.69",
  "M6.391 20.279a10 10 0 0 1-2.69-2.7",
] as const;
export const circleDotDashedIconPaths = [
  ...circleDashedIconPaths,
  "M13 12a1 1 0 1 0-2 0 1 1 0 0 0 2 0Z",
] as const;
export const clockIconPaths = [circleIconPath, "M12 6v6l4 2"] as const;
export const userCheckIconPaths = [
  "m16 11 2 2 4-4",
  "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
  "M13 7a4 4 0 1 0-8 0 4 4 0 1 0 8 0Z",
] as const;
export const circleCheckIconPaths = [
  circleIconPath,
  "m16 9-5.5 5.5L8 12",
] as const;
export const circleXIconPaths = [circleIconPath, "m15 9-6 6m0-6 6 6"] as const;
export const signalLowIconPaths = ["M2 20h.01", "M7 20v-4"] as const;
export const signalMediumIconPaths = [
  ...signalLowIconPaths,
  "M12 20v-8",
] as const;
export const signalHighIconPaths = [
  ...signalMediumIconPaths,
  "M17 20V8",
] as const;
export const flameIconPaths = [
  "M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4",
] as const;

export const filesIconPaths = [
  "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
] as const;

export const uploadIconPaths = [
  "M12 16V3m-5 5 5-5 5 5",
  "M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3",
] as const;

export const trashIconPaths = [
  "M3 6h18M9 6V4h6v2m4 0-1 14H6L5 6m5 4v6m4-6v6",
] as const;

export const outlineIcon = <Message>(
  h: HtmlBuilder<Message>,
  paths: readonly string[],
) =>
  h.svg(
    [
      h.ViewBox("0 0 24 24"),
      h.Width("16"),
      h.Height("16"),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("2"),
      h.StrokeLinecap("round"),
      h.StrokeLinejoin("round"),
      h.AriaHidden(true),
    ],
    paths.map((path) => h.path([h.D(path)], [])),
  );

export const backIcon = <Message>(h: HtmlBuilder<Message>) =>
  outlineIcon(h, ["M19 12H5m7 7-7-7 7-7"]);

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
