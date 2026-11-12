import { Schema } from "effect";

export const linksPath = "/api/links";

const WebUrl = Schema.Trimmed.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    if (
      !/^https?:\/\//i.test(value) ||
      /\s/u.test(value) ||
      !URL.canParse(value)
    ) {
      return "Enter a valid HTTP or HTTPS URL.";
    }
    const url = new URL(value);
    if (url.username || url.password)
      return "Remove the credentials from the URL.";
  }),
);

export const SaveLink = Schema.Struct({
  url: Schema.Trim.pipe(Schema.decodeTo(WebUrl)),
});

export const Link = Schema.Struct({
  id: Schema.String,
  url: WebUrl,
  savedAt: Schema.Int,
});

export const LinkList = Schema.Array(Link);
