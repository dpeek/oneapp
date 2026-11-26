// Adapted from CreaseUI (MIT), revision b11a974af28917ae6fea67cbf9ade89d8a3c464c.
// See ../THIRD_PARTY_NOTICES.md for source and license.
import { Combobox } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import { Option } from "effect";
import { childAttributes, type HtmlBuilder } from "foldkit/html";
import { mapMessage } from "foldkit/mount";
import { fieldClassNames } from "./field.ts";
import { outlineIcon } from "./icons.ts";
import { controls } from "./tokens.stylex.ts";

export const { Message, FocusInput } = Combobox;
export const { Model, init } = Combobox.Multi;
const combobox = Combobox.Multi.create<string>();
export const { update } = combobox;

const styles = stylex.create({
  wrapper: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem",
    padding: "0.25rem",
    minBlockSize: "2.25rem",
    minInlineSize: 0,
    boxSizing: "border-box",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: {
      default: controls.pillRadius,
      ':has([data-slot="tokenizer-remove"])': controls.radius,
    },
    borderColor: { default: controls.border, ":focus-within": controls.focus },
    boxShadow: {
      ":focus-within": `0 0 0 1px color-mix(in srgb, ${controls.focus} 35%, transparent)`,
    },
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    maxInlineSize: "100%",
    minBlockSize: "1.625rem",
    paddingInline: "0.5rem 0.125rem",
    borderRadius: controls.radius,
    backgroundColor: controls.hover,
    fontSize: "0.8125rem",
  },
  chipLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  remove: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    inlineSize: "1.5rem",
    blockSize: "1.5rem",
    padding: 0,
    borderStyle: "none",
    borderRadius: controls.pillRadius,
    color: "inherit",
    backgroundColor: {
      default: "transparent",
      ":hover": controls.surface,
    },
    cursor: { default: "pointer", ":disabled": "default" },
    outline: { ":focus-visible": `2px solid ${controls.focus}` },
    outlineOffset: 1,
  },
  combobox: {
    display: "contents",
  },
  inputWrapper: {
    flex: "1 1 8rem",
    minInlineSize: 0,
  },
  input: {
    boxSizing: "border-box",
    inlineSize: "100%",
    minBlockSize: "1.625rem",
    paddingBlock: 0,
    paddingInline: "0.375rem",
    borderStyle: "none",
    backgroundColor: "transparent",
    color: controls.foreground,
    fontFamily: "inherit",
    fontSize: { default: "1rem", "@media (min-width: 768px)": "0.875rem" },
    outline: "none",
    "::placeholder": { color: controls.mutedForeground },
  },
  panel: {
    zIndex: 50,
    boxSizing: "border-box",
    inlineSize: "var(--button-width)",
    maxInlineSize: "calc(100vw - 1rem)",
    padding: "0.25rem",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: controls.border,
    borderRadius: controls.radius,
    backgroundColor: controls.popover,
    color: controls.foreground,
    boxShadow: "0 4px 16px #0002",
    fontSize: "0.875rem",
  },
  list: {
    maxBlockSize: "16rem",
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  option: {
    padding: "0.375rem 0.5rem",
    borderRadius: controls.radius,
    overflowWrap: "anywhere",
    cursor: "pointer",
  },
  activeOption: { backgroundColor: controls.hover },
  description: { color: controls.mutedForeground, fontSize: "0.8125rem" },
  error: { color: "light-dark(#ab3723, #ffa693)", fontSize: "0.8125rem" },
});

type Item = Readonly<{ id: string; name: string }>;

export const view = <Msg>(
  props: {
    model: typeof Model.Type;
    label: string;
    placeholder: string;
    placement?: "top-start" | "bottom-start";
    emptyMessage: string;
    items: readonly Item[];
    selected: readonly Item[];
    maxLength: number;
    busy: boolean;
    full: boolean;
    description: string | null;
    error: string | null;
    toParentMessage: (message: typeof Message.Type) => Msg;
    onRemove: (id: string) => Msg;
  },
  h: HtmlBuilder<Msg>,
) => {
  const { model, toParentMessage } = props;
  const anchor = { placement: props.placement ?? "bottom-start", gap: 4 };
  const inputId = Combobox.inputId(model.id);
  const wrapperId = `${model.id}-field`;
  const messageId = `${model.id}-message`;
  const labels = new Map(props.items.map(({ id, name }) => [id, name]));
  const feedback =
    props.error ??
    props.description ??
    (labels.size === 0 && model.inputValue.trim() ? props.emptyMessage : null);
  const displayText = (id: string) => labels.get(id) ?? id;
  const message = feedback
    ? [
        h.div(
          [
            h.Id(messageId),
            h.Class(
              stylex.props(props.error ? styles.error : styles.description)
                .className ?? "",
            ),
            h.Role("status"),
          ],
          [feedback],
        ),
      ]
    : [];
  return h.div(
    [h.Class(fieldClassNames.root), h.DataAttribute("slot", "tokenizer")],
    [
      h.label([h.For(inputId), h.Class(fieldClassNames.label)], [props.label]),
      ...(props.error ? message : []),
      h.div(
        [
          h.Id(wrapperId),
          h.Class(stylex.props(styles.wrapper).className ?? ""),
        ],
        [
          ...props.selected.map(({ id, name }) =>
            h.span(
              [h.Key(id), h.Class(stylex.props(styles.chip).className ?? "")],
              [
                h.span(
                  [h.Class(stylex.props(styles.chipLabel).className ?? "")],
                  [name],
                ),
                h.button(
                  [
                    h.Type("button"),
                    h.DataAttribute("slot", "tokenizer-remove"),
                    h.AriaLabel(`Remove tag ${name}`),
                    h.Disabled(props.busy),
                    h.Class(stylex.props(styles.remove).className ?? ""),
                    h.OnClick(props.onRemove(id)),
                  ],
                  [outlineIcon(h, ["m7 7 10 10M17 7 7 17"])],
                ),
              ],
            ),
          ),
          h.submodel({
            slotId: model.id,
            model,
            view: combobox.view,
            toParentMessage,
            viewInputs: {
              items: [...labels.keys()],
              restingInputValue: "",
              selectedValues: props.selected.map(({ id }) => id),
              itemToValue: (id) => id,
              itemToDisplayText: displayText,
              itemToConfig: (id, { isActive }) => ({
                className: stylex.props(
                  styles.option,
                  isActive && styles.activeOption,
                ).className,
                content: h.span([], [displayText(id)]),
              }),
              className: stylex.props(styles.combobox).className,
              inputWrapperClassName: stylex.props(styles.inputWrapper)
                .className,
              inputClassName: stylex.props(styles.input).className,
              inputPlaceholder: props.placeholder,
              inputAttributes: childAttributes([
                h.DataAttribute("slot", "input"),
                h.Maxlength(props.maxLength),
                h.Disabled(props.full),
                ...(props.full || props.busy
                  ? []
                  : [
                      h.OnClick(
                        toParentMessage(
                          Message.Opened({
                            maybeActiveItemIndex: Option.none(),
                          }),
                        ),
                      ),
                    ]),
                ...(feedback ? [h.AriaDescribedBy(messageId)] : []),
              ]),
              openOnFocus: true,
              isDisabled: props.full,
              isReadOnly: props.busy,
              isInvalid: props.error !== null,
              itemsClassName: stylex.props(styles.panel).className,
              itemsScrollClassName: stylex.props(styles.list).className,
              itemsAttributes: childAttributes([
                h.OnMount(
                  mapMessage(
                    Combobox.AnchorCombobox({ buttonId: wrapperId, anchor }),
                    toParentMessage,
                  ),
                ),
              ]),
              anchor,
            },
          }),
        ],
      ),
      ...(props.error ? [] : message),
    ],
  );
};
