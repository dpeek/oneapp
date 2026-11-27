import { createAvatar, createFileInput, createNativeSelect } from "@orumai/ui";
import { Schema } from "effect";
import {
  companyAvatarPath,
  CompanyWebsiteImages,
  companyWebsiteImagesPath,
} from "./company-avatar-contract.ts";
import { isCompanyDomain, normalizeCompanyDomain } from "./company-domains.ts";
import { contactValuesChanged } from "./contact-values.ts";
import { senderIconDomain } from "./mail-domain.ts";
import {
  normalizePersonEmail,
  personPhotoPath,
  type Person,
} from "./people-contract.ts";

export const photoTypes = ["image/jpeg", "image/png", "image/webp"];
export const isProfilePhoto = (file: File) =>
  file.size <= 10 * 1024 * 1024 && photoTypes.includes(file.type);

const readImages = Schema.decodeUnknownSync(CompanyWebsiteImages);

export const mountCompanyAvatar = (
  element: HTMLFieldSetElement,
  person: Person | null,
  fallback: string,
) => {
  const form = element.form;
  if (!form) return;
  const saved = person?.photo ? personPhotoPath(person.id, person.photo) : null;
  const savedSource = person?.avatarStyle === "website" ? "website" : "upload";
  const source = createNativeSelect({
    label: "Avatar image",
    options: [
      { value: "automatic", label: "Automatic" },
      { value: "website", label: "Choose from website" },
      { value: "upload", label: "Upload image" },
    ],
    value: saved ? savedSource : "automatic",
  });
  const fit = createNativeSelect({
    label: "Image framing",
    options: [
      { value: "fit", label: "Fit" },
      { value: "fill", label: "Fill" },
    ],
    value:
      person?.avatarStyle === "fill" || (saved && !person?.avatarStyle)
        ? "fill"
        : "fit",
  });
  const file = createFileInput({
    label: "Company image",
    accept: photoTypes.join(","),
  });
  source.select.name = "companyAvatarSource";
  fit.select.name = "companyAvatarFit";
  file.input.name = "companyPhoto";

  const selected = document.createElement("input");
  selected.type = "hidden";
  selected.name = "websitePhoto";
  const preview = document.createElement("div");
  preview.className = "company-avatar-preview";
  const panel = document.createElement("div");
  panel.className = "company-avatar-fields";
  const upload = document.createElement("div");
  upload.className = "company-avatar-upload";
  upload.append(file.element, fit.element);

  const website = document.createElement("div");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.className = "person-value-status";
  const choices = document.createElement("div");
  choices.className = "company-avatar-choices";
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "Website images");
  website.append(status, choices);
  panel.append(source.element, upload, website, selected);
  element.replaceChildren(preview, panel);

  const listeners = new AbortController();
  const { signal } = listeners;
  let load: AbortController | undefined;
  let loadedHost: string | null = null;
  let uploadUrl: string | null = null;
  const photoUrl = (photo: string) => `data:image/jpeg;base64,${photo}`;
  const primaryDomain = () => {
    const fields = new FormData(form);
    const host = fields
      .getAll("domains")
      .map(String)
      .map(normalizeCompanyDomain)
      .find(Boolean);
    if (host) return isCompanyDomain(host) ? host : null;
    const email = fields
      .getAll("addresses")
      .map(String)
      .map(normalizePersonEmail)
      .filter(Boolean)
      .sort()[0];
    return email ? senderIconDomain(email) : null;
  };
  const showPreview = (host = primaryDomain()) => {
    const mode = source.select.value;
    let src = null;
    if (mode === "automatic") src = host ? companyAvatarPath(host) : null;
    else if (mode === "website") {
      src = selected.value
        ? photoUrl(selected.value)
        : savedSource === mode
          ? saved
          : null;
    } else {
      src = uploadUrl ?? (savedSource === mode ? saved : null);
    }
    preview.replaceChildren(
      createAvatar({
        fallback,
        src,
        variant: "square",
        size: "lg",
        fit:
          mode === "upload" && fit.select.value === "fit" ? "contain" : "cover",
      }),
    );
  };

  const loadChoices = async (host: string | null) => {
    if (loadedHost === host && host) return;
    load?.abort();
    choices.replaceChildren();
    loadedHost = host;
    if (!host) {
      status.textContent =
        "Enter a valid primary domain to see website images.";
      return;
    }
    const request = new AbortController();
    load = request;
    status.textContent = "Looking for website images…";
    try {
      const response = await fetch(companyWebsiteImagesPath(host), {
        signal: request.signal,
      });
      if (!response.ok) throw new Error();
      const images = readImages(await response.json());
      if (request.signal.aborted) return;
      status.textContent = images.length
        ? ""
        : "No usable images found on this website.";
      const options = images.map(
        ({ photo, width, height, scalable }, index) => {
          const option = document.createElement("button");
          option.type = "button";
          const size = scalable ? "SVG" : `${width} × ${height}`;
          option.setAttribute(
            "aria-label",
            `Website image ${index + 1} (${size})`,
          );
          option.setAttribute("aria-pressed", String(selected.value === photo));
          option.append(
            createAvatar({
              fallback,
              src: photoUrl(photo),
              variant: "square",
              fit: "cover",
            }),
          );
          option.addEventListener("click", () => {
            selected.value = photo;
            for (const button of choices.querySelectorAll("button"))
              button.setAttribute("aria-pressed", String(button === option));
            showPreview();
          });
          return option;
        },
      );
      choices.replaceChildren(...options);
    } catch {
      if (request.signal.aborted) return;
      loadedHost = null;
      status.textContent =
        "Website images are unavailable. Switch modes and try again.";
    }
  };

  const refresh = () => {
    const mode = source.select.value;
    upload.hidden = mode !== "upload";
    website.hidden = mode !== "website";
    const host = primaryDomain();
    showPreview(host);
    if (mode === "website") void loadChoices(host);
  };
  const domainChanged = (event: Event) => {
    if (
      event.type === contactValuesChanged ||
      (event.target instanceof HTMLInputElement &&
        ["domains", "addresses"].includes(event.target.name))
    )
      refresh();
  };
  source.select.addEventListener("change", refresh, { signal });
  fit.select.addEventListener("change", () => showPreview(), { signal });
  form.addEventListener("change", domainChanged, { signal });
  form.addEventListener(contactValuesChanged, domainChanged, { signal });
  file.input.addEventListener(
    "change",
    () => {
      if (uploadUrl) URL.revokeObjectURL(uploadUrl);
      const image = file.input.files?.[0];
      uploadUrl =
        image && isProfilePhoto(image) ? URL.createObjectURL(image) : null;
      showPreview();
    },
    { signal },
  );
  refresh();
  return () => {
    listeners.abort();
    load?.abort();
    if (uploadUrl) URL.revokeObjectURL(uploadUrl);
  };
};
