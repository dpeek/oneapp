// A single live region follows the active modal, including native showModal()
// dialogs and Foldkit's aria-modal dialogs. The queue stays in the app Model.
export const placeNotificationHost = (element: HTMLElement) => {
  const home = element.parentElement!;
  const document = element.ownerDocument;
  let opened: HTMLDialogElement[] = [];
  const reconcile = (records: MutationRecord[] = []) => {
    const candidates = [
      ...document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
    ].filter(
      (dialog) =>
        dialog.matches(":modal") ||
        dialog.getAttribute("aria-modal") === "true",
    );
    opened = opened.filter((dialog) => candidates.includes(dialog));
    for (const record of records) {
      if (
        record.attributeName === "open" &&
        record.target instanceof HTMLDialogElement &&
        candidates.includes(record.target)
      ) {
        opened = opened.filter((dialog) => dialog !== record.target);
        opened.push(record.target);
      }
    }
    for (const dialog of candidates)
      if (!opened.includes(dialog)) opened.push(dialog);
    // Native modals occupy the browser top layer above ordinary dialogs.
    const parent =
      opened.filter((dialog) => dialog.matches(":modal")).at(-1) ??
      opened.at(-1) ??
      home;
    if (element.parentElement === parent) return;
    const active = document.activeElement;
    const restore =
      active instanceof HTMLElement && element.contains(active) ? active : null;
    parent.append(element);
    restore?.focus({ preventScroll: true });
  };
  const observer = new MutationObserver(reconcile);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open", "aria-modal"],
  });
  reconcile();
  return () => {
    observer.disconnect();
    element.remove();
  };
};
