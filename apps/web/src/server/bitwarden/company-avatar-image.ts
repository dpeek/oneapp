import {
  initPhoton,
  PhotonImage,
  resize,
  SamplingFilter,
} from "@cf-wasm/photon/others";
import { imageSize } from "image-size";
import { companyAvatarSize } from "../../company-avatar-contract.ts";

const maxDimension = 2048;
const isBounded = (width: number, height: number) =>
  width > 0 && height > 0 && Math.max(width, height) <= maxDimension;

const hasBoundedDimensions = (bytes: Uint8Array, type: string) => {
  if (type !== "image/x-icon") {
    const { width, height } = imageSize(bytes);
    return isBounded(width, height);
  }

  // ICO directory dimensions are one byte. Check the embedded dimensions too.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (!count || count > 32 || 6 + 16 * count > bytes.length) return false;
  for (let entry = 6; entry < 6 + 16 * count; entry += 16) {
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (length < 24 || offset + length > bytes.length) return false;
    if (view.getUint32(offset) === 0x89504e47) {
      if (
        !hasBoundedDimensions(
          bytes.subarray(offset, offset + length),
          "image/png",
        )
      )
        return false;
    } else if (
      !isBounded(
        view.getInt32(offset + 4, true),
        view.getInt32(offset + 8, true),
      )
    ) {
      return false;
    }
  }
  return true;
};

type Artwork = {
  width: number;
  height: number;
  coverage: number;
  shape: number;
  photo: string;
};
export type RenderCompanyAvatar = (
  bytes: Uint8Array,
  type: string,
) => Artwork | null;

const size = companyAvatarSize;
const sampleArtwork = (pixels: Uint8Array, width: number, height: number) => {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let alpha = 0;
  let luminance = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const opacity = pixels[i + 3]!;
      if (opacity > 0) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        alpha += opacity;
        luminance +=
          opacity *
          (0.213 * pixels[i]! +
            0.715 * pixels[i + 1]! +
            0.072 * pixels[i + 2]!);
      }
    }
  }
  if (!alpha) return null;
  const coverage = alpha / (255 * width * height);
  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
    coverage,
    matte: luminance / alpha > 195 && coverage < 0.98 ? 32 : 255,
  };
};

export const createCompanyAvatarRenderer =
  (module: WebAssembly.Module): RenderCompanyAvatar =>
  (bytes, type) => {
    try {
      if (!hasBoundedDimensions(bytes, type)) return null;
      if (!initPhoton.ready) initPhoton.sync({ module });
      using source = PhotonImage.new_from_byteslice(bytes);
      const width = source.get_width();
      const height = source.get_height();
      if (!isBounded(width, height)) return null;

      const scale = size / Math.max(width, height);
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      using sample = resize(source, w, h, SamplingFilter.Triangle);
      const pixels = sample.get_raw_pixels();
      const mark = sampleArtwork(pixels, w, h);
      if (!mark) return null;

      const shape = Math.min(w, h) / Math.max(w, h);
      const cover = mark.coverage >= 0.98 && shape >= 0.87;
      const cropWidth = cover ? Math.min(w, h) : mark.width;
      const cropHeight = cover ? Math.min(w, h) : mark.height;
      const offsetX = cover ? Math.floor((w - cropWidth) / 2) : mark.left;
      const offsetY = cover ? Math.floor((h - cropHeight) / 2) : mark.top;
      const crop = new Uint8Array(cropWidth * cropHeight * 4);
      for (let y = 0; y < cropHeight; y++) {
        const from = ((offsetY + y) * w + offsetX) * 4;
        crop.set(
          pixels.subarray(from, from + cropWidth * 4),
          y * cropWidth * 4,
        );
      }
      using cropped = new PhotonImage(crop, cropWidth, cropHeight);
      const extent = cover ? size : Math.round(size * 0.82);
      const factor = extent / Math.max(cropWidth, cropHeight);
      const tileWidth = Math.max(1, Math.round(cropWidth * factor));
      const tileHeight = Math.max(1, Math.round(cropHeight * factor));
      using markImage = resize(
        cropped,
        tileWidth,
        tileHeight,
        SamplingFilter.Triangle,
      );

      // Composite on a solid, contrasting tile so transparent marks keep their edges.
      const tile = new Uint8Array(size * size * 4).fill(mark.matte);
      const colors = markImage.get_raw_pixels();
      const x0 = Math.floor((size - tileWidth) / 2);
      const y0 = Math.floor((size - tileHeight) / 2);
      for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
          const from = (y * tileWidth + x) * 4;
          const to = ((y + y0) * size + x + x0) * 4;
          const opacity = colors[from + 3]! / 255;
          for (let channel = 0; channel < 3; channel++)
            tile[to + channel] = Math.round(
              colors[from + channel]! * opacity + mark.matte * (1 - opacity),
            );
        }
      }
      for (let i = 3; i < tile.length; i += 4) tile[i] = 255;
      using derivative = new PhotonImage(tile, size, size);
      return {
        width,
        height,
        coverage: mark.coverage,
        shape,
        photo: derivative.get_bytes_jpeg(88).toBase64(),
      };
    } catch {
      return null;
    }
  };
