import { Schema } from "effect";

export const bitwardenDevicesPath = "/api/bitwarden/devices";

export const BitwardenDeviceId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u),
);

export const BitwardenDeviceList = Schema.Array(
  Schema.Struct({
    id: BitwardenDeviceId,
    name: Schema.String,
    createdAt: Schema.Int,
  }),
);
