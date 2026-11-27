import { senderIconDomain } from "../mail-domain.ts";
import { expect, it } from "@effect/vitest";
import { inferSenderAppearance, type SenderHeader } from "./mail-sender.ts";
import { mailPeople } from "./mail-people.ts";

const infer = (
  address: string,
  headers: Partial<Record<SenderHeader, string>> = {},
  name = "",
) => inferSenderAppearance({ address, name }, (key) => headers[key]);

it("recognizes role mailboxes and explicit suffixes without matching personal substrings", () => {
  for (const local of [
    "noreply",
    "no-reply",
    "no_reply",
    "do.not.reply",
    "notifications",
    "accounts",
    "billing",
    "receipts",
    "marketing",
    "newsletter",
    "no-reply+receipt",
    "accounts-au",
  ])
    expect(infer(`${local}@mail.example.co.uk`, {}, "Example")).toEqual({
      kind: "service",
      mode: "auto",
      domain: "example.co.uk",
    });
  for (const local of [
    "annaccounts",
    "billingham",
    "notificationsmith",
    "team",
    "support",
    "hello",
    "info",
    "jane",
  ])
    expect(infer(`${local}@example.com`, {}, "Jane Smith")).toBeUndefined();
});

it("uses automated and list headers for ambiguous roles without treating vacation replies as service mail", () => {
  expect(
    infer(
      "support@example.com",
      { "auto-submitted": "Auto-Generated; owner=service" },
      "Example Support",
    )?.kind,
  ).toBe("service");
  expect(
    infer(
      "hello@example.com",
      { "list-unsubscribe": "<mailto:leave@example.com>" },
      "Example",
    )?.kind,
  ).toBe("service");
  expect(
    infer("team@example.com", { "list-id": "Updates <updates.example.com>" })
      ?.kind,
  ).toBe("service");
  expect(
    infer("person@example.com", { "auto-submitted": "auto-replied" }),
  ).toBeUndefined();
  expect(
    infer("support@example.com", { "auto-submitted": "no" }, "Jane Smith"),
  ).toBeUndefined();
  expect(
    infer("support@example.com", { "list-id": "garbage" }, "Jane Smith"),
  ).toBeUndefined();
  expect(
    infer(
      "jane@example.com",
      { "list-unsubscribe": "<https://example.com/leave>" },
      "Jane Smith",
    ),
  ).toBeUndefined();
});

it("resolves company domains using public and private suffixes and skips personal providers", () => {
  expect(senderIconDomain("accounts@notices.acme.co.uk")).toBe("acme.co.uk");
  expect(senderIconDomain("noreply@news.acme.github.io")).toBe(
    "acme.github.io",
  );
  for (const domain of [
    "gmail.com",
    "outlook.com",
    "yahoo.co.uk",
    "icloud.com",
    "proton.me",
    "fastmail.com",
  ])
    expect(senderIconDomain(`noreply@${domain}`)).toBeNull();
  for (const address of [
    "not-an-address",
    "a@127.0.0.1",
    "a@localhost",
    "a@intranet.local",
    "a@co.uk",
  ])
    expect(senderIconDomain(address)).toBeNull();
  expect(infer("noreply@gmail.com")).toEqual({
    kind: "service",
    mode: "auto",
    domain: null,
  });
});

it("uses the visible From sender rather than the delivery envelope for the company icon", () => {
  const people = mailPeople(
    (key) =>
      key === "from"
        ? "Acme Accounts <accounts@notices.acme.co.uk>"
        : undefined,
    "bounce@mailer.example.net",
    "owner@example.net",
  );
  expect(people.sender).toMatchObject({
    address: "accounts@notices.acme.co.uk",
    appearance: { domain: "acme.co.uk" },
  });
  expect(people.members[0]?.appearance).toEqual(people.sender?.appearance);
  expect(
    mailPeople(
      () => undefined,
      "noreply@delivery.example.com",
      "owner@example.net",
    ).sender?.appearance,
  ).toBeUndefined();
  expect(
    mailPeople(() => undefined, "mail@app.example.net", "alice@example.net")
      .sender?.appearance,
  ).toBeUndefined();
});

it("recognizes named automated reports and newsletters with role senders", () => {
  expect(
    infer(
      "reports@example.com",
      { "auto-submitted": "auto-generated" },
      "Example Reports",
    )?.kind,
  ).toBe("service");
  expect(
    infer(
      "updates@example.com",
      { "list-unsubscribe": "<https://example.com/unsubscribe>" },
      "Example",
    )?.kind,
  ).toBe("service");
});

it("recognizes transactional mailbox tokens, including prefixed no-reply and tagged invoices", () => {
  for (const local of [
    "drive-shares-dm-noreply",
    "product-do_not_reply",
    "digital-no-reply",
    "auto-confirm",
    "shipment-tracking",
    "order-update",
    "invoice+statements+acct_123",
    "upcoming-invoice+acct_123",
    "notify",
    "verify",
    "ticketoffice",
    "onlinecustomersupport",
    "customersupport.au",
    "fieldservice-au",
  ])
    expect(infer(`${local}@example.com`, {}, "Example")?.kind).toBe("service");
  for (const local of [
    "annaccounts",
    "billingham",
    "invoiceman",
    "notnoreply",
    "noreplysmith",
    "supporter",
  ])
    expect(infer(`${local}@example.com`, {}, "Jane Smith")).toBeUndefined();
});

it("uses delivery subdomains while respecting public suffix and private-tenant boundaries", () => {
  for (const host of [
    "email03.account.acme.com",
    "messages.acme.com",
    "trx.mail2.acme.com",
    "s.acme.co.uk",
    "updates.acme.com",
    "comms.acme.com",
    "mail.publisher.github.io",
  ])
    expect(infer(`sender@${host}`, {}, "Acme")?.kind).toBe("service");
  expect(infer("jane@mail.acme.com", {}, "Jane Smith")?.kind).toBe("service");
  expect(infer("jane@regional.acme.com", {}, "Jane Smith")).toBeUndefined();
  expect(infer("jane@acme.co.uk", {}, "Jane Smith")).toBeUndefined();
  expect(infer("jane@publisher.github.io", {}, "Jane Smith")).toBeUndefined();
});

it("keeps named employees, institutional subdomains and personal-provider mail personal", () => {
  for (const [address, name] of [
    ["jane.smith@health.nsw.gov.au", "Jane Smith (Sydney LHD)"],
    ["js123@police.nsw.gov.au", "Jane Smith"],
    ["jane.smith@etud.university.fr", "Jane Smith"],
    ["jane@research.university.edu", "Dr Jane Smith"],
    ["jsmith@acme.com", "Jane Smith"],
    ["js123@ace.com", "Grace Hopper"],
    ["jane@smith.com", "Jane Smith"],
    ["jane@internode.on.net", "Jane Smith"],
    ["jane@bigpond.net.au", ""],
    ["hello@clinic.com", "Dr Jane Smith"],
    ["grace.hopper@example.com", "Grace Hopper"],
  ])
    expect(infer(address!, {}, name!)).toBeUndefined();
  expect(
    infer(
      "jane.smith@health.nsw.gov.au",
      { "auto-submitted": "auto-generated" },
      "Jane Smith",
    ),
  ).toBeUndefined();
  for (const domain of [
    "internode.on.net",
    "bigpond.net.au",
    "optusnet.com.au",
    "iinet.net.au",
  ])
    expect(senderIconDomain(`noreply@${domain}`)).toBeNull();
});

it("recognizes shared business mailboxes and organization names without treating every branded domain as a company sender", () => {
  for (const [address, name] of [
    ["support@coretools.com.au", "Core Tools Support"],
    ["hello@acme.com", "Acme"],
    ["office@acme.com", ""],
    ["admin@acme.com", "Acme Accountants"],
    ["admissions@school.edu.au", "International Grammar School"],
    ["australia@acme.com", "Acme Australia"],
    ["propertysystem@propertysystem.com", "Jane Smith"],
    ["cooperative@pm.me", "The Carpentry Collective"],
    ["sender@regional.acme.com", ""],
  ])
    expect(infer(address!, {}, name!)?.kind).toBe("service");
  expect(infer("jane@acme.com", {}, "Jane Smith")).toBeUndefined();
  expect(
    infer(
      "jane@acme.com",
      { "list-unsubscribe": "<https://acme.com/leave>" },
      "Jane Smith",
    ),
  ).toBeUndefined();
  expect(
    infer(
      "janesmith@substack.com",
      { "list-id": "<updates.example.com>" },
      "Jane Smith",
    ),
  ).toBeUndefined();
});
