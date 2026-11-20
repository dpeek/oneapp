import * as stylex from "@stylexjs/stylex";
import { Effect } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import { controls } from "./tokens.stylex.ts";

const Message = defineMessageUnion({ CompletedAvatarImageMount: {} });

const RevealAvatarImage = Mount.define("RevealAvatarImage", {
  messages: [Message.CompletedAvatarImageMount],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLImageElement)) return;
        const reveal = () => element.setAttribute("data-loaded", "");
        if (element.complete && element.naturalWidth > 0) reveal();
        else element.addEventListener("load", reveal, { once: true });
        return () => element.removeEventListener("load", reveal);
      }),
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
  layer: { gridArea: "1 / 1" },
  image: {
    inlineSize: "100%",
    blockSize: "100%",
    boxSizing: "border-box",
    padding: "0.625rem",
    objectFit: "contain",
    backgroundColor: controls.hover,
    visibility: { default: "hidden", ":where([data-loaded])": "visible" },
  },
});

type AvatarProps<Message> = Readonly<{
  fallback: Html;
  src: string | null;
  imageMounted: Message;
}>;

export const avatar = <Message>(
  { fallback, src, imageMounted }: AvatarProps<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.DataAttribute("slot", "avatar"),
      h.Class(stylex.props(styles.root).className ?? ""),
    ],
    [
      h.span(
        [
          h.DataAttribute("slot", "avatar-fallback"),
          h.Class(stylex.props(styles.layer).className ?? ""),
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
              h.Class(stylex.props(styles.layer, styles.image).className ?? ""),
              h.OnMount(
                Mount.mapMessage(RevealAvatarImage(), () => imageMounted),
              ),
              h.Src(src),
            ]),
          ]
        : []),
    ],
  );
