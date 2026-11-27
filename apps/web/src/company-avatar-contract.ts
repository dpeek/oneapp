import { Schema } from "effect";

export const companyAvatarSize = 192;
export const CompanyAvatarStyle = Schema.Literals(["website", "fit", "fill"]);
export type CompanyAvatarStyle = typeof CompanyAvatarStyle.Type;

export const CompanyWebsiteImages = Schema.Array(
  Schema.Struct({
    width: Schema.Number,
    height: Schema.Number,
    scalable: Schema.Boolean,
    photo: Schema.String,
  }),
);
export type CompanyWebsiteImages = typeof CompanyWebsiteImages.Type;
export const companyAvatarPath = (host: string) => `/icons/${host}/company.jpg`;
export const companyWebsiteImagesPath = (host: string) =>
  `/icons/${host}/company.json`;
