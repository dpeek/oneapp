// Opaque colour conversions adapted from CreaseUI's color-picker.
export type Hsv = Readonly<{ h: number; s: number; v: number }>;
export const colorFormats = ["hex", "rgb", "hsl", "hsb"] as const;
export type ColorFormat = (typeof colorFormats)[number];

export const clamp = (value: number, max = 1) =>
  Math.max(0, Math.min(value, max));
const hue = (value: number) => ((value % 360) + 360) % 360;
const byte = (fraction: number) => Math.round(clamp(fraction) * 255);

const rgbToHsv = (r: number, g: number, b: number): Hsv => {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * ((g - b) / delta);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return { h: hue(h), s: max === 0 ? 0 : delta / max, v: max };
};

const hsvToRgb = ({ h, s, v }: Hsv) => {
  const sector = hue(h) / 60;
  const chroma = s * v;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const channels = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  return channels[Math.floor(sector)]!.map((channel) =>
    byte(channel + v - chroma),
  );
};

const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const readNumber = (raw: string) =>
  numberPattern.test(raw) ? Number(raw) : NaN;

export const parseColor = (value: string): Hsv | null => {
  const text = value.trim().toLowerCase();
  const hex = /^#?([a-f0-9]{3}|[a-f0-9]{6})$/u.exec(text)?.[1];
  if (hex) {
    const parts =
      hex.length === 3
        ? Array.from(hex, (digit) => digit + digit)
        : hex.match(/../gu)!;
    const [r, g, b] = parts.map((part) => Number.parseInt(part, 16) / 255);
    return rgbToHsv(r!, g!, b!);
  }
  const call = /^(rgb|hsl|hsb)\(([^()]+)\)$/u.exec(text);
  if (!call) return null;
  const body = call[2]!.trim();
  const parts = body.split(body.includes(",") ? /\s*,\s*/u : /\s+/u);
  if (parts.length !== 3) return null;
  if (call[1] === "rgb") {
    const channels = parts.map((part) =>
      part.endsWith("%")
        ? readNumber(part.slice(0, -1)) / 100
        : readNumber(part) / 255,
    );
    return channels.every(Number.isFinite)
      ? rgbToHsv(clamp(channels[0]!), clamp(channels[1]!), clamp(channels[2]!))
      : null;
  }
  const [first, second, third] = parts as [string, string, string];
  const h = readNumber(first.replace(/deg$/u, ""));
  const s = second.endsWith("%") ? readNumber(second.slice(0, -1)) / 100 : NaN;
  const amount = third.endsWith("%")
    ? readNumber(third.slice(0, -1)) / 100
    : NaN;
  if (![h, s, amount].every(Number.isFinite)) return null;
  if (call[1] === "hsb") return { h: hue(h), s: clamp(s), v: clamp(amount) };
  const lightness = clamp(amount);
  const v = lightness + clamp(s) * Math.min(lightness, 1 - lightness);
  return { h: hue(h), s: v === 0 ? 0 : 2 * (1 - lightness / v), v };
};

export const formatColor = (color: Hsv, format: ColorFormat) => {
  if (format === "hex")
    return (
      "#" +
      hsvToRgb(color)
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")
    );
  if (format === "rgb") return `rgb(${hsvToRgb(color).join(", ")})`;
  const { h, s, v } = color;
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  if (format === "hsb")
    return `hsb(${Math.round(h)}, ${percent(s)}, ${percent(v)})`;
  const lightness = v * (1 - s / 2);
  const saturation =
    lightness === 0 || lightness === 1
      ? 0
      : (v - lightness) / Math.min(lightness, 1 - lightness);
  return `hsl(${Math.round(h)}, ${percent(saturation)}, ${percent(lightness)})`;
};
