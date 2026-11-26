import * as stylex from "@stylexjs/stylex";
import { Effect } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import { controls } from "./tokens.stylex.ts";

const Message = defineMessageUnion({ CompletedAvatarImageMount: {} });

const revealAvatarImage = (element: HTMLImageElement) => {
  const reveal = () => element.setAttribute("data-loaded", "");
  if (element.complete && element.naturalWidth > 0) reveal();
  else element.addEventListener("load", reveal, { once: true });
  return () => element.removeEventListener("load", reveal);
};

const RevealAvatarImage = Mount.define("RevealAvatarImage", {
  messages: [Message.CompletedAvatarImageMount],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        element instanceof HTMLImageElement
          ? revealAvatarImage(element)
          : undefined,
      ),
      (cleanup) => Effect.sync(() => cleanup?.()),
    ).pipe(Effect.as(Message.CompletedAvatarImageMount())),
});

const styles = stylex.create({
  root: {
    display: "grid",
    placeItems: "center",
    inlineSize: "2.5rem",
    blockSize: "2.5rem",
    borderRadius: "50%",
    overflow: "hidden",
    backgroundColor: controls.hover,
    color: controls.mutedForeground,
  },
  square: { borderRadius: controls.radius },
  small: {
    inlineSize: "1.25rem",
    blockSize: "1.25rem",
    fontSize: "0.625rem",
    fontWeight: 600,
  },
  large: {
    inlineSize: "4rem",
    blockSize: "4rem",
    fontSize: "1.25rem",
    fontWeight: 600,
  },
  layer: { gridArea: "1 / 1" },
  image: {
    inlineSize: "100%",
    blockSize: "100%",
    boxSizing: "border-box",
    padding: "0.625rem",
    objectFit: "contain",
    backgroundColor: controls.hover,
    visibility: { default: "hidden", ":where([data-loaded])": "inherit" },
  },
  photo: { objectFit: "cover", padding: 0 },
});

type AvatarAppearance = Readonly<{
  variant?: "round" | "square";
  size?: "sm" | "lg";
  fit?: "cover";
}>;

type AvatarProps<Message> = AvatarAppearance &
  Readonly<{
    fallback: Html | string;
    src: string | null;
    imageMounted: Message;
  }>;

const avatarClassName = ({ variant, size }: AvatarAppearance) =>
  stylex.props(
    styles.root,
    variant === "square" && styles.square,
    size === "sm" && styles.small,
    size === "lg" && styles.large,
  ).className ?? "";

const fallbackClassName = stylex.props(styles.layer).className ?? "";
const imageClassName = (fit: AvatarAppearance["fit"]) =>
  stylex.props(styles.layer, styles.image, fit === "cover" && styles.photo)
    .className ?? "";

export const avatar = <Message>(
  {
    fallback,
    src,
    imageMounted,
    variant = "round",
    size,
    fit,
  }: AvatarProps<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.DataAttribute("slot", "avatar"),
      h.DataAttribute("variant", variant),
      h.Class(avatarClassName({ variant, size })),
    ],
    [
      h.span(
        [
          h.DataAttribute("slot", "avatar-fallback"),
          h.Class(fallbackClassName),
        ],
        [fallback],
      ),
      ...(src
        ? [
            h.img([
              h.Key(src),
              h.DataAttribute("slot", "avatar-image"),
              h.Alt(""),
              h.Loading("lazy"),
              h.Decoding("async"),
              h.Referrerpolicy("no-referrer"),
              h.Class(imageClassName(fit)),
              h.OnMount(
                Mount.mapMessage(RevealAvatarImage(), () => imageMounted),
              ),
              h.Src(src),
            ]),
          ]
        : []),
    ],
  );

// Shared Avatar for callers that render directly into the DOM.
export const createAvatar = ({
  fallback,
  src,
  variant = "round",
  size,
  fit,
}: AvatarAppearance &
  Readonly<{ fallback: Node | string; src: string | null }>) => {
  const element = document.createElement("span");
  element.dataset.slot = "avatar";
  element.dataset.variant = variant;
  element.setAttribute("aria-hidden", "true");
  element.className = avatarClassName({ variant, size });

  const placeholder = document.createElement("span");
  placeholder.dataset.slot = "avatar-fallback";
  placeholder.className = fallbackClassName;
  placeholder.append(fallback);
  element.append(placeholder);

  if (src) {
    const image = document.createElement("img");
    image.dataset.slot = "avatar-image";
    image.className = imageClassName(fit);
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = src;
    revealAvatarImage(image);
    element.append(image);
  }
  return element;
};
