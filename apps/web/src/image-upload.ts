import { Schema } from "effect";

export const imageUploadLimitMiB = 5;
export const imageUploadLimit = imageUploadLimitMiB * 1024 * 1024;
export const ImageMediaType = Schema.Literals(["image/png", "image/jpeg"]);
export const invalidImage = `Choose a PNG or JPEG image up to ${imageUploadLimitMiB} MiB.`;
