import type { R2Bucket, R2Object } from "@cloudflare/workers-types";
import PostalMime, { type Email } from "postal-mime";
import type { MailFolder } from "../inbox-contract.ts";
import { mailMimeOptions } from "./mail-attachments.ts";
import { isMailingList, type IndexedMail } from "./mail-index.ts";
import { mailPeople } from "./mail-people.ts";
import { conversationMessageIds } from "./mail-reply.ts";

export const rawMailFormat = "import-rfc822-v1";

export const storedMailTimestamp = (object: R2Object) => {
  const value = Number(object.customMetadata?.originalTimestamp);
  return object.customMetadata?.originalTimestamp !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 9_999_999_999_999
    ? value
    : object.uploaded.getTime();
};

// Parse only headers during ingestion/indexing, leaving MIME bodies untouched.
export const parseRawHeaders = (bytes: Uint8Array) => {
  const header = bytes.subarray(0, mailMimeOptions.maxHeadersSize);
  for (let index = 0; index < header.length - 1; index++) {
    const lf = header[index] === 10 && header[index + 1] === 10;
    const cr = header[index] === 13 && header[index + 1] === 13;
    const crlf =
      header[index] === 13 &&
      header[index + 1] === 10 &&
      header[index + 2] === 13 &&
      header[index + 3] === 10;
    if (lf || cr || crlf)
      return PostalMime.parse(
        header.subarray(0, index + (crlf ? 4 : 2)),
        mailMimeOptions,
      );
  }
  throw new Error("Message headers are missing or exceed the header limit");
};

export const describeRawMail = (
  object: R2Object,
  email: Email,
  folder: MailFolder,
): IndexedMail => {
  const header = (name: string) =>
    email.headers.find(({ key }) => key === name)?.value;
  const from = email.from?.address ?? "";
  const to = (email.to ?? [])
    .flatMap((address) =>
      address.group
        ? address.group.map((member) => member.address)
        : [address.address],
    )
    .filter(Boolean)
    .join(", ");
  return {
    id: object.key,
    folder,
    from,
    to,
    envelopeRecipient: object.customMetadata?.envelopeTo,
    subject: email.subject?.trim().slice(0, 200) ?? "",
    timestamp: storedMailTimestamp(object),
    unread: object.customMetadata?.initialUnread === "1",
    ...(object.customMetadata?.initialArchived !== undefined
      ? { initialArchived: object.customMetadata.initialArchived === "1" }
      : {}),
    people: mailPeople(header, from, to),
    listMail: isMailingList(header("list-id")),
    messageIds: conversationMessageIds(header),
  };
};

export const describeStoredRawMail = async (
  bucket: R2Bucket,
  object: R2Object,
  folder: MailFolder,
) => {
  const raw = await bucket.get(object.key, {
    range: {
      offset: 0,
      length: Math.min(object.size, mailMimeOptions.maxHeadersSize),
    },
  });
  if (!raw) return null;
  return describeRawMail(
    object,
    await parseRawHeaders(new Uint8Array(await raw.arrayBuffer())),
    folder,
  );
};
