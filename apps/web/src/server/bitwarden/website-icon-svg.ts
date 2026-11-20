import { initWasm, Resvg } from "@resvg/resvg-wasm";

export type RasterizeSvg = (
  bytes: Uint8Array,
) => Promise<Uint8Array<ArrayBuffer> | null>;

const maxSvgBytes = 128 * 1024;
const maxSourceDimension = 16_384;
const iconSize = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });
// Keep the renderer in vector-only mode, including for SVGs with embedded bitmaps.
const unsupportedMarkup =
  /<!doctype\b|<(?:[^\s<>/:]+:)?(?:image|feImage)(?=[\s/>])/iu;

export const createSvgRasterizer = (
  module: WebAssembly.Module,
): RasterizeSvg => {
  let ready: Promise<void> | undefined;

  return async (bytes) => {
    if (bytes.byteLength > maxSvgBytes) return null;
    try {
      const svg = decoder.decode(bytes);
      if (unsupportedMarkup.test(svg)) return null;

      await (ready ??= initWasm(module));
      const font = { loadSystemFonts: false };
      let icon = new Resvg(svg, {
        font,
        fitTo: { mode: "width", value: iconSize },
      });
      try {
        if (
          icon.width < 1 ||
          icon.height < 1 ||
          icon.width > maxSourceDimension ||
          icon.height > maxSourceDimension
        )
          return null;
        if (icon.height > icon.width) {
          const fitted = new Resvg(svg, {
            font,
            fitTo: { mode: "height", value: iconSize },
          });
          icon.free();
          icon = fitted;
        }
        const rendered = icon.render();
        try {
          if (rendered.width > iconSize || rendered.height > iconSize)
            return null;
          return new Uint8Array(rendered.asPng());
        } finally {
          rendered.free();
        }
      } finally {
        icon.free();
      }
    } catch {
      return null;
    }
  };
};
