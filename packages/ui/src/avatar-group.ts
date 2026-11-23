import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  group: { display: "inline-flex", alignItems: "center" },
  interactiveGroup: {
    display: "flex",
    flexWrap: "wrap",
    rowGap: "0.25rem",
    paddingInlineStart: "0.375rem",
  },
  member: {
    display: "grid",
    placeItems: "center",
    boxSizing: "border-box",
    border: `2px solid ${controls.surface}`,
    borderRadius: "50%",
    flexShrink: 0,
  },
  overlap: { marginInlineStart: "-0.375rem" },
  interactiveMember: { position: "relative", zIndex: { ":focus-within": 1 } },
  overflow: {
    blockSize: "1.75rem",
    minInlineSize: "1.75rem",
    paddingInline: "0.1875rem",
    backgroundColor: controls.hover,
    color: controls.mutedForeground,
    fontSize: "0.6875rem",
    fontWeight: 600,
  },
});

type Avatar = Readonly<{ key: string; label: string; picture: Html }>;
const visibleLimit = 5;

// Crease's small AvatarGroup overlap and overflow chip.
export const avatarGroup = <Message>(
  avatars: ReadonlyArray<Avatar>,
  h: HtmlBuilder<Message>,
  interactiveLabel?: string,
  limit?: number,
): Html => {
  const interactive = interactiveLabel !== undefined;
  const visible = avatars.slice(
    0,
    limit ?? (interactive ? avatars.length : visibleLimit),
  );
  const hidden = avatars.slice(visible.length);
  return h.div(
    [
      h.DataAttribute("slot", "avatar-group"),
      h.Role(interactive ? "group" : "img"),
      h.AriaLabel(
        interactiveLabel ?? avatars.map(({ label }) => label).join(", "),
      ),
      h.Class(
        stylex.props(styles.group, interactive && styles.interactiveGroup)
          .className ?? "",
      ),
    ],
    [
      ...visible.map(({ key, label, picture }, index) =>
        h.span(
          [
            h.Key(key),
            ...(interactive ? [] : [h.Title(label), h.AriaHidden(true)]),
            h.Class(
              stylex.props(
                styles.member,
                (interactive || index > 0) && styles.overlap,
                interactive && styles.interactiveMember,
              ).className ?? "",
            ),
          ],
          [picture],
        ),
      ),
      ...(hidden.length
        ? [
            h.span(
              [
                h.DataAttribute("slot", "avatar-group-overflow"),
                h.Title(hidden.map(({ label }) => label).join("\n")),
                h.AriaHidden(true),
                h.Class(
                  stylex.props(styles.member, styles.overlap, styles.overflow)
                    .className ?? "",
                ),
              ],
              [`+${hidden.length}`],
            ),
          ]
        : []),
    ],
  );
};
