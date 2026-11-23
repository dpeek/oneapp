import {
  buttonClassName,
  fieldClassNames,
  inputClassName,
  noiseIconPath,
} from "@oneapp/ui";
import { Schema } from "effect";
import { isCompanyDomain } from "./company-domains.ts";
import { NoiseSenders, noiseSendersApiPath } from "./inbox-contract.ts";
import {
  companyDomainLimit,
  normalizePersonEmail,
  personAddressLimit,
  PersonEmail,
} from "./people-contract.ts";

const readEmail = Schema.decodeUnknownOption(PersonEmail);
const fields = {
  addresses: {
    heading: "Email addresses",
    rowLabel: "Email address",
    addLabel: "Add email",
    placeholder: "name@example.com",
    inputMode: "email",
    limit: personAddressLimit,
    invalid: "Enter a valid email address.",
    isValid: (value: string) => readEmail(value)._tag === "Some",
  },
  domains: {
    heading: "Website domains",
    rowLabel: "Website domain",
    addLabel: "Add domain",
    placeholder: "example.com",
    inputMode: "url",
    limit: companyDomainLimit,
    invalid: "Enter a domain such as example.com.",
    isValid: isCompanyDomain,
  },
};

const labelButton = (button: HTMLButtonElement, label: string) => {
  button.title = label;
  button.setAttribute("aria-label", label);
};

const iconButton = (path: string) => {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.slot = "button";
  button.className = buttonClassName({
    variant: "ghost",
    size: "icon-sm",
    rounded: true,
  });
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", path);
  shape.setAttribute("fill", "none");
  shape.setAttribute("stroke", "currentColor");
  shape.setAttribute("stroke-width", "2");
  shape.setAttribute("stroke-linecap", "round");
  icon.append(shape);
  button.append(icon);
  return button;
};

type Row = {
  element: HTMLDivElement;
  control: HTMLInputElement;
  label: HTMLLabelElement;
  remove: HTMLButtonElement;
  noise: HTMLButtonElement | null;
};

export const mountContactValues = async (
  fieldset: HTMLFieldSetElement,
  name: keyof typeof fields,
  values: readonly string[],
  signal: AbortSignal,
) => {
  const field = fields[name];
  const prefix = fieldset.id;
  const heading = document.createElement("span");
  heading.id = `${prefix}-label`;
  heading.className = fieldClassNames.label;
  heading.textContent = field.heading;
  fieldset.setAttribute("aria-labelledby", heading.id);

  const add = iconButton("M12 5v14M5 12h14");
  labelButton(add, field.addLabel);
  const header = document.createElement("div");
  header.className = "person-value-header";
  header.append(heading, add);
  const list = document.createElement("div");
  list.className = "person-value-list";
  const status = document.createElement("p");
  status.className = "person-value-status";
  status.setAttribute("role", "status");
  const limitMessage = `Use up to ${field.limit} ${field.heading.toLowerCase()}.`;
  fieldset.replaceChildren(header, list, status);
  const noiseInput = document.createElement("input");
  noiseInput.type = "hidden";
  noiseInput.name = "noiseChanges";
  if (name === "addresses") {
    fieldset.append(noiseInput);
  } else {
    const help = document.createElement("p");
    help.id = `${prefix}-help`;
    help.className = "person-value-help";
    help.textContent =
      "Mail matches senders at any of these domains and their subdomains. The primary domain supplies the default favicon.";
    fieldset.setAttribute("aria-describedby", help.id);
    fieldset.append(help);
  }

  const rows: Row[] = [];
  let noiseSenders: ReadonlySet<string> | null = null;
  const noiseChanges = new Map<string, boolean>();
  let nextId = 0;

  const refreshNoise = () => {
    const submitted = new Map<string, boolean>();
    rows.forEach(({ control, noise }, index) => {
      if (!noise) return;
      const address = normalizePersonEmail(control.value);
      const valid = Boolean(address) && control.validity.valid;
      const changed = valid ? noiseChanges.get(address) : undefined;
      noise.disabled = !noiseSenders || !valid;
      labelButton(
        noise,
        `Noise for ${valid ? address : `email address ${index + 1}`}`,
      );
      const pressed = valid && (changed ?? noiseSenders?.has(address) ?? false);
      noise.setAttribute("aria-pressed", String(pressed));
      if (changed !== undefined) submitted.set(address, changed);
    });
    noiseInput.value = submitted.size
      ? JSON.stringify(
          Array.from(submitted, ([address, noise]) => ({ address, noise })),
        )
      : "";
  };

  const refresh = () => {
    add.disabled = rows.length >= field.limit;
    status.textContent = rows.length > field.limit ? limitMessage : "";
    const primary =
      name === "domains"
        ? (rows.find(({ control }) => control.value.trim()) ?? rows[0])
        : undefined;
    rows.forEach((row, index) => {
      const label = `${field.rowLabel} ${index + 1}`;
      row.label.textContent = row === primary ? "Primary domain" : label;
      row.label.classList.toggle("person-value-label-hidden", row !== primary);
      labelButton(row.remove, `Remove ${label.toLowerCase()}`);
    });
    if (name === "addresses") refreshNoise();
  };

  const insertRow = (value = "", position = rows.length, showError = false) => {
    const control = document.createElement("input");
    control.id = `${prefix}-${++nextId}`;
    control.name = name;
    control.value = value;
    control.className = inputClassName;
    control.dataset.slot = "input";
    control.inputMode = field.inputMode;
    control.placeholder = field.placeholder;
    control.autocomplete = "off";
    control.autocapitalize = "none";
    control.spellcheck = false;

    const label = document.createElement("label");
    label.htmlFor = control.id;
    label.className = "person-value-label";
    const error = document.createElement("p");
    error.id = `${control.id}-error`;
    error.className = "person-value-error";
    error.setAttribute("role", "alert");
    control.setAttribute("aria-describedby", error.id);

    const remove = iconButton("M6 6l12 12M18 6 6 18");
    const noise = name === "addresses" ? iconButton(noiseIconPath) : null;
    const actions = document.createElement("div");
    actions.className = "person-value-actions";
    if (noise) {
      noise.classList.add("person-noise-toggle");
      noise.addEventListener("click", () => {
        if (!noiseSenders) return;
        const address = normalizePersonEmail(control.value);
        const initial = noiseSenders.has(address);
        const next = !(noiseChanges.get(address) ?? initial);
        if (next === initial) noiseChanges.delete(address);
        else noiseChanges.set(address, next);
        refreshNoise();
      });
      actions.append(noise);
    }
    actions.append(remove);
    const element = document.createElement("div");
    element.className = "person-value-row";
    element.append(label, control, actions, error);
    const row = { element, control, label, remove, noise };
    list.insertBefore(element, rows[position]?.element ?? null);
    rows.splice(position, 0, row);

    const validate = () => {
      const trimmed = control.value.trim();
      const message = trimmed && !field.isValid(trimmed) ? field.invalid : "";
      control.setCustomValidity(message);
      error.textContent = showError ? message : "";
      if (error.textContent) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    };
    const revealError = () => {
      showError = true;
      validate();
    };
    validate();
    control.addEventListener("blur", revealError);
    control.addEventListener("invalid", revealError);
    control.addEventListener("input", () => {
      validate();
      refresh();
    });
    control.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text || !/[\r\n,]/u.test(text)) return;
      const before = control.value.slice(0, control.selectionStart ?? 0);
      const after = control.value.slice(
        control.selectionEnd ?? control.value.length,
      );
      const [first, ...remaining] = `${before}${text}${after}`
        .split(/[\r\n,]+/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!first) return;
      event.preventDefault();
      if (remaining.length && rows.length + remaining.length > field.limit) {
        status.textContent = limitMessage;
        return;
      }
      const index = rows.indexOf(row);
      control.value = first;
      remaining.forEach((entry, offset) => {
        insertRow(entry, index + offset + 1, true);
      });
      revealError();
      refresh();
    });
    remove.addEventListener("click", () => {
      const index = rows.indexOf(row);
      rows.splice(index, 1);
      element.remove();
      refresh();
      (rows[index]?.control ?? rows.at(-1)?.control ?? add).focus();
    });
    return control;
  };

  add.addEventListener("click", () => {
    const control = insertRow();
    refresh();
    control.focus();
  });
  for (const value of values.length ? values : [""]) insertRow(value);
  refresh();
  if (name === "addresses") {
    try {
      const response = await fetch(noiseSendersApiPath, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("Could not load Noise settings.");
      const { addresses } = Schema.decodeUnknownSync(NoiseSenders)(
        await response.json(),
      );
      if (signal.aborted) return;
      noiseSenders = new Set(addresses);
      refreshNoise();
    } catch {
      if (signal.aborted) return;
      const error = document.createElement("p");
      error.className = "person-value-error";
      error.setAttribute("role", "alert");
      error.textContent =
        "Could not load Noise settings. Reopen the editor to try again.";
      fieldset.append(error);
    }
  }
};
