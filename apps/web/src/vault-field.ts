type FieldControl = HTMLInputElement | HTMLTextAreaElement;
type FieldOptions = {
  label: string;
  value: string | FieldControl;
  masked?: boolean;
  copyable?: boolean;
  suffix?: string;
  showLabel?: boolean;
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
} as const;

const svgNamespace = "http://www.w3.org/2000/svg";
const iconButton = (
  button: HTMLButtonElement,
  icon: keyof typeof iconPaths,
  label: string,
) => {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of iconPaths[icon]) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  button.replaceChildren(svg);
  button.setAttribute("aria-label", label);
  button.title = label;
};

const fieldButton = () => {
  const button = document.createElement("button");
  button.className = "vault-field-button";
  button.type = "button";
  return button;
};

let fieldId = 0;
const placeholderText = "••••••••";

export const vaultField = ({
  label,
  value,
  masked = false,
  copyable = true,
  suffix,
  showLabel = true,
}: FieldOptions) => {
  const element = document.createElement("div");
  element.className = "vault-field";
  const body = document.createElement("div");
  body.className = "vault-field-body";
  const actions = document.createElement("div");
  actions.className = "vault-field-actions";
  const preview = document.createElement("span");
  preview.className = "vault-field-value";
  const control = typeof value === "string" ? undefined : value;
  const visibleType =
    control instanceof HTMLInputElement && control.type !== "password"
      ? control.type
      : "text";
  const text = () => (typeof value === "string" ? value : value.value);
  const toggle = fieldButton();
  let concealed = masked;

  if (control) {
    if (showLabel) {
      const caption = document.createElement("label");
      caption.className = "vault-field-label";
      control.id ||= `vault-field-${++fieldId}`;
      caption.htmlFor = control.id;
      caption.textContent = label;
      element.append(caption);
    } else control.setAttribute("aria-label", label);
    body.append(control);
    if (control instanceof HTMLTextAreaElement) {
      preview.classList.add("vault-field-placeholder");
      preview.textContent = placeholderText;
      preview.setAttribute("aria-hidden", "true");
      body.append(preview);
    }
  } else {
    body.append(preview);
    if (suffix) body.append(suffix);
  }

  const renderVisibility = () => {
    if (control instanceof HTMLInputElement)
      control.type = concealed ? "password" : visibleType;
    else if (control) {
      control.hidden = concealed;
      preview.hidden = !concealed;
    } else preview.textContent = concealed ? placeholderText : text();
    if (masked)
      iconButton(
        toggle,
        concealed ? "show" : "hide",
        `${concealed ? "Show" : "Hide"} ${label}`,
      );
    toggle.hidden = !masked;
  };

  toggle.addEventListener("click", () => {
    concealed = !concealed;
    renderVisibility();
  });
  actions.append(toggle);
  element.append(body, actions);
  renderVisibility();

  const canCopy = copyable && (control !== undefined || text() !== "");
  if (canCopy) {
    const copy = fieldButton();
    const copyLabel = `Copy ${label}`;
    iconButton(copy, "copy", copyLabel);
    actions.append(copy);

    const feedback = document.createElement("span");
    feedback.className = "vault-field-feedback";
    feedback.setAttribute("aria-live", "polite");
    element.append(feedback);

    let sequence = 0;
    let timeout: number | undefined;
    const updateCopy = () =>
      copy.setAttribute("aria-disabled", String(text() === ""));
    control?.addEventListener("input", updateCopy);
    updateCopy();
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
        ? `${label} copied.`
        : "Couldn’t copy to the clipboard.";
      iconButton(copy, copied ? "check" : "copy", copyLabel);
      timeout = window.setTimeout(() => {
        feedback.textContent = "";
        feedback.removeAttribute("data-error");
        iconButton(copy, "copy", copyLabel);
      }, 2000);
    });
  }

  actions.hidden = !masked && !canCopy;
  return {
    element,
    setMaskable(maskable: boolean) {
      masked = concealed = maskable;
      actions.hidden = !masked && !canCopy;
      renderVisibility();
    },
  };
};
