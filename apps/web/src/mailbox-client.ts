import {
  defaultMailboxId,
  mailboxParameter,
  mailboxUrl,
} from "./mail-settings-contract.ts";

export const mailboxFromSearch = (search: string) =>
  new URLSearchParams(search).get(mailboxParameter) ?? defaultMailboxId;

export const selectedMailbox = () =>
  typeof window === "undefined"
    ? defaultMailboxId
    : mailboxFromSearch(window.location.search);

export const selectedMailboxUrl = (path: string) =>
  mailboxUrl(path, selectedMailbox());

export const mailFetch = (path: string, init?: RequestInit) =>
  fetch(selectedMailboxUrl(path), init);
