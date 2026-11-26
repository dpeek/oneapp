import {
  buttonClassName,
  createField,
  createInputGroup,
  inputGroupControlClassName,
} from "@orumai/ui";
import { vaultIcon } from "./vault-item-icon.ts";

type FieldControl = HTMLInputElement | HTMLTextAreaElement;
type FieldOptions = {
  label: string;
  value: string | FieldControl;
  masked?: boolean;
  copyable?: boolean;
  href?: string;
  showLabel?: boolean;
  actionLabel?: string;
};

const iconPaths = {
  copy: [
    "M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z",
    "M3 15V5a2 2 0 0 1 2-2h10",
  ],
  show: [
    "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  ],
  hide: [
    "M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8",
    "M10 6.2c.6-.1 1.3-.2 2-.2 6.4 0 10 6 10 6a15 15 0 0 1-2.4 2.9M6.3 7.7C3.6 9.4 2 12 2 12s3.6 6 10 6c1.5 0 2.9-.3 4.1-.8",
  ],
  check: ["m5 12 4 4L19 6"],
  open: ["M13 5h6v6m0-6-8 8", "M19 13v6H5V5h6"],
} as const;

const iconButton = (
  button: HTMLButtonElement | HTMLAnchorElement,
  icon: keyof typeof iconPaths,
  label: string,
) => {
  button.replaceChildren(vaultIcon(iconPaths[icon]));
  button.setAttribute("aria-label", label);
  button.title = label;
};

const fieldAction = <Tag extends "a" | "button">(tag: Tag) => {
  const button = document.createElement(tag);
  button.className = `vault-field-button ${buttonClassName({ variant: "ghost", size: "icon-sm" })}`;
  button.dataset.slot = "button";
  if (button instanceof HTMLButtonElement) button.type = "button";
  return button;
};

const placeholderText = "••••••••";

export const vaultField = ({
  label,
  value,
  masked = false,
  copyable = true,
  href,
  showLabel = true,
  actionLabel = label,
}: FieldOptions) => {
  const body = document.createElement("div");
  body.className = "vault-field-body";
  const actions = document.createElement("div");
  const preview = document.createElement("span");
  preview.className = "vault-field-value";
  const control = typeof value === "string" ? undefined : value;
  const visibleType =
    control instanceof HTMLInputElement && control.type !== "password"
      ? control.type
      : "text";
  const text = () => (typeof value === "string" ? value : value.value);
  const toggle = fieldAction("button");
  let concealed = masked;

  if (control) {
    control.dataset.slot =
      control instanceof HTMLTextAreaElement ? "textarea" : "input";
    control.className += ` ${inputGroupControlClassName(control instanceof HTMLTextAreaElement)}`;
    body.append(control);
    if (control instanceof HTMLTextAreaElement) {
      preview.className += ` vault-field-placeholder ${inputGroupControlClassName(false)}`;
      preview.textContent = placeholderText;
      preview.setAttribute("aria-hidden", "true");
      body.append(preview);
    }
  } else {
    body.className += ` ${inputGroupControlClassName(false)}`;
    body.append(preview);
  }

  const renderVisibility = () => {
    if (control instanceof HTMLInputElement)
      control.type = concealed ? "password" : visibleType;
    else if (control) {
      control.hidden = concealed;
      preview.hidden = !concealed;
    } else preview.textContent = concealed ? placeholderText : text();
    if (masked) {
      iconButton(
        toggle,
        concealed ? "show" : "hide",
        `${concealed ? "Show" : "Hide"} ${actionLabel}`,
      );
      if (!toggle.parentElement) actions.prepend(toggle);
    } else toggle.remove();
  };

  toggle.addEventListener("click", () => {
    concealed = !concealed;
    renderVisibility();
  });
  const element = createField({
    label,
    content: createInputGroup(body, actions),
    control,
    showLabel,
  });
  element.classList.add("vault-field");
  renderVisibility();

  if (href) {
    const open = fieldAction("a");
    open.href = href;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    iconButton(open, "open", `Open ${actionLabel.toLowerCase()} in a new tab`);
    actions.append(open);
  }
  const canCopy = copyable && !control && text() !== "";
  if (canCopy) {
    const copy = fieldAction("button");
    const copyLabel = `Copy ${actionLabel}`;
    iconButton(copy, "copy", copyLabel);
    actions.append(copy);

    const feedback = document.createElement("span");
    feedback.className = "vault-field-feedback";
    feedback.id = `vault-copy-feedback-${crypto.randomUUID()}`;
    copy.setAttribute("aria-describedby", feedback.id);
    feedback.setAttribute("aria-live", "polite");
    element.append(feedback);

    let sequence = 0;
    let timeout: number | undefined;
    copy.addEventListener("click", async () => {
      const value = text();
      if (!value) return;
      const attempt = ++sequence;
      window.clearTimeout(timeout);
      let copied = false;
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch {
        // Clipboard access can be unavailable or denied by the browser.
      }
      if (!element.isConnected || attempt !== sequence) return;
      feedback.toggleAttribute("data-error", !copied);
      feedback.textContent = copied
        ? `${actionLabel} copied.`
        : "Couldn’t copy to the clipboard. Try Copy again.";
      iconButton(copy, copied ? "check" : "copy", copyLabel);
      if (!copied) return;
      timeout = window.setTimeout(() => {
        feedback.textContent = "";
        feedback.removeAttribute("data-error");
        iconButton(copy, "copy", copyLabel);
      }, 2000);
    });
  }

  actions.hidden = !masked && !canCopy && !href;
  return {
    element,
    setMaskable(maskable: boolean) {
      masked = concealed = maskable;
      actions.hidden = !masked && !canCopy && !href;
      renderVisibility();
    },
  };
};
