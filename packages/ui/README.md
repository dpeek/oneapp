# Shared UI

See [Components and style system](STYLE_SYSTEM.md) for Crease component adoption,
StyleX tokens, and theme guidance.

## Toast notifications

`Toast` from `@oneapp/ui` adapts CreaseUI's StyleX toast to OneApp's tokens and
buttons. Its state and commands use the installed Foldkit toast primitive. The
source revision and license are recorded in `THIRD_PARTY_NOTICES.md`.

Use toasts selectively for explicit user actions when they add useful information
or recovery. A visible change usually confirms success on its own, especially
when another readily available action can reverse it. Reversibility alone does
not require a notification.

- Show send confirmations, uncertain outcomes, partial success, and operational
  failures that would otherwise go unnoticed.
- Offer delete Undo when the item disappears and recovery requires finding Trash.
- Keep Links saves/deletes, archive moves, restores, read/unread changes, and
  sender preference changes quiet on success. Their visible state is sufficient.
- Successful retries silently dismiss the earlier failure. Restoring mail also
  dismisses its deletion Undo, including when restored through Trash.
- Keep validation, loading errors with Retry, and workflow instructions in context.
  Routine background work should not generate toasts.

Do not announce the same result both inline and in a toast. Never include
passwords, copied values, or decrypted vault content in notification state.

### Defaults

- Bottom-right, with at most three visible entries. The stack expands on hover
  or keyboard focus; older queued entries wait until space is available.
- Success, information, and neutral messages dismiss after four seconds.
- Errors, warnings, and any toast with an action stay until dismissed or acted on.
  `sticky: false` explicitly opts into a timer; `duration` customizes that timer.
- Hover and keyboard focus pause dismissal. Queued entries cannot expire unseen.
- F6 focuses the notification region. Tab reaches actions and dismiss buttons;
  Escape dismisses the focused toast. Notifications never take focus on arrival.
- Reduced-motion preferences disable transitions. Mobile placement includes the
  safe-area inset and the inherited `--bottom-nav-size`, if present.

### Integration

Own one `Toast.Model` in the application, initialized with a stable, unique ID:

```ts
import { Toast } from "@oneapp/ui";

const initial = Toast.init({ id: "notifications" });
const result = Toast.show(initial, Toast.success({ title: "Email sent." }));
```

Embed `Toast.Message` in the parent's message schema. Route those messages through
`Toast.update`, retaining its model and mapping **all** returned commands to the
parent. `show`, `updateToast`, `dismiss`, and `dismissAll` also return model/command
updates; discarding commands breaks animation and timers.

Render `Toast.toast({ model, toParentMessage }, h)` even when the queue is empty,
so the live region exists before notifications arrive. This view requires the
same StyleX compilation and theme variables as the other shared UI components.

`Toast.show(model, Toast.success({ title: "Email deleted.", actionLabel: "Undo" }))`
creates an actionable toast. The parent associates the returned entry's ID with
the exact operation to undo. `Toast.update` emits `OutMessage.ActivatedToast`
with that entry once when its action is activated, and `DismissedToast` after an
entry leaves. Use those events to dispatch the operation and clean up action
state. Do not look up the current selection when handling Undo.

`Toast.updateToast(model, id, input)` changes an existing entry and refreshes its
timer without losing hover/focus/queue pauses. Changing its variant or adding an
action applies the default persistence policy again; `sticky` overrides it.

At feature boundaries, emit only accepted request completions, ignore stale
responses, and coalesce repeated notifications for the same operation. Keep action routing and
deduplication in the application, outside the visual component.

### Web application adoption

The web shell owns the queue in `apps/web/src/notifications.ts`. Features emit
typed outcomes with a stable key, variant, title, and optional description.
Repeating a key updates the existing toast. Features can also emit
`DismissNotification` for that key to silently clear resolved failures or obsolete
Undo actions; this retains dismissal commands and immediately removes the action
payload. Optional typed actions store the original Mail message
ID alongside the toast ID. Action activation dispatches that operation once;
dismissal and account resets discard the payload. A result without an action
replaces an older actionable toast without retaining its Undo button.

`notification-view.ts` and `notification-host.ts` maintain one live region and
move its host into the active native or Foldkit modal. Escape inside the toast
dismisses the notification without closing the surrounding dialog. On mobile,
the viewport sits above the bottom navigation. The standalone password-recovery
application also mounts the shared host; its workflow instructions remain inline.

Notifications survive ordinary navigation. Account resets clear the queue and
advance its generation, rejecting old timer and keyboard messages. A changed
toast model ID remounts the live region's observers with the new message routing.

Links request IDs guard against stale responses and repeated completions.
Save/delete failures emit toasts; successful operations silently dismiss earlier
errors. Invalid URLs and loading failures stay beside the input or Retry control.

Mail send/reply results emit toasts, preserving drafts on failure. A sent email
with an unsaved copy or failed conversation completion produces a persistent
warning without a resend action. Compose validation stays inline. Archive moves
and restores complete quietly and clear earlier errors. Archive can be reversed
through the Inbox/Archive controls without a toast action.

Explicit read/unread, sender priority, and sender appearance changes report only
failures in toasts. Their menus close immediately, so an inline error could be
missed after navigation. Request state retains the original message subject or
sender address; successful retries quietly clear only that operation's error.
Automatic mark-as-read failures stay inline with the message. Loading, image,
and attachment recovery feedback also remains in context. A successful automatic
mark-as-read silently clears an earlier read-status error for that message.

Mail deletion retains Undo with a per-message key and the original subject. It
survives navigation and multiple operations, retains its target on failure, and
remains available if another restore is busy. Successful restoration removes the
Undo or restore error without adding a success toast.

Contacts/profile dialogs keep validation, load, and save failures inline beside
the form. Directory edits also keep errors inline while their editor is visible;
if the user leaves before a save fails, a toast identifies the original contact.
Successful saves stay quiet and clear any earlier toast for that contact.

Connected-client revocation failures stay inline on Settings, beside Revoke.
If the user navigates away while revocation is pending, a toast identifies the
client whose revocation failed. Success removes the row and silently clears an
earlier error. Client loading failures and Retry remain inline. Load/revoke
request IDs reject late completions after reset or a newer operation; client
identity includes both type and ID. Returning to inline feedback dismisses an
earlier toast to avoid duplicate announcements.

Account verification codes, credential-change instructions, validation, and
sign-in-again notices remain inline. A failed account action that completes away
from Settings emits only a generic toast; server messages, codes, passwords, and
entered values never enter notification state. Returning to Settings dismisses
that toast and restores the detailed inline context. Request IDs reject late
completions after account reset or a newer operation.

Vault clipboard feedback remains local to the field: a check icon and live
announcement confirm copying. Copy failures persist beside Copy until a retry
succeeds, with the message associated with the button for assistive technology.
Copying never emits a global notification or puts field labels, item metadata,
or decrypted values into application notification state. Responses from detached
fields or superseded copy attempts are ignored.

### Remaining feedback audit

The remaining surfaces intentionally retain local feedback:

| Surface                                                        | Feedback retained in context                                            | Reason                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Sign-in, password recovery, CLI and extension approval         | Validation, failures, verification and next-step instructions           | Users need the form or instruction to continue.                                                   |
| Mail, Links, Contacts and connected-client loading             | Loading, unavailable data, Retry, attachment and image errors           | The recovery control and affected content are visible together.                                   |
| Mail editor and compose attachments                            | Validation and file preparation errors                                  | Users must correct the draft or selected file.                                                    |
| Vault setup, unlock, editing, folders and lifecycle operations | Local errors and operation status                                       | Feedback belongs to the unlocked workspace; decrypted content stays out of the application queue. |
| Vault import and export                                        | Review, result counts, download confirmation and partial-export details | These are workflow results, including details needed to inspect incomplete exports.               |
| Extension popup                                                | Connection instructions, save confirmation and failures                 | The popup is a separate application; saving has no visible list update there.                     |

This completes the current toast migration audit. New feedback should follow the
selective policy above; an inline status or alert alone is not a reason to migrate.
