const hasBytes = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((byte, index) => bytes[index] === byte);

export const detectFilePreviewType = (bytes: Uint8Array) => {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const signature = new TextDecoder().decode(bytes.subarray(0, 12));
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a"))
    return "image/gif";
  if (signature.startsWith("RIFF") && signature.slice(8) === "WEBP")
    return "image/webp";
  if (signature.startsWith("%PDF-")) return "application/pdf";
  return null;
};
