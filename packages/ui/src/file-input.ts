import * as stylex from "@stylexjs/stylex";
import type { HtmlBuilder } from "foldkit/html";
import { createField, field } from "./field.ts";
import { outlineIcon } from "./icons.ts";
import { alertColors, controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  root: { display: "grid", gap: "0.375rem", minInlineSize: 0 },
  compact: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    boxSizing: "border-box",
    minBlockSize: "2.25rem",
    paddingInline: "0.625rem",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: { default: controls.border, ":focus-within": controls.focus },
    borderRadius: controls.radius,
    backgroundColor: {
      default: controls.surface,
      "@media (hover: hover)": {
        ":hover:not([data-disabled])": controls.hover,
      },
    },
    boxShadow: {
      ":focus-within": `0 0 0 1px color-mix(in srgb, ${controls.focus} 35%, transparent)`,
    },
    color: controls.mutedForeground,
    fontSize: "0.875rem",
    opacity: { ":is([data-disabled])": 0.55 },
  },
  invalid: {
    borderColor: {
      default: alertColors.error,
      ":focus-within": alertColors.error,
    },
  },
  control: {
    position: "absolute",
    inset: 0,
    inlineSize: "100%",
    blockSize: "100%",
    margin: 0,
    opacity: 0,
    cursor: { default: "pointer", ":disabled": "default" },
  },
  fileName: {
    contain: "inline-size",
    flexGrow: 1,
    minInlineSize: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  feedback: {
    margin: 0,
    color: controls.mutedForeground,
    fontSize: "0.875rem",
    ":empty": { display: "none" },
  },
  error: { color: alertColors.error },
});

const uploadIconPath = "M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5";
const controlClassName = stylex.props(styles.control).className ?? "";
const triggerClassName = (invalid = false) =>
  stylex.props(styles.compact, invalid && styles.invalid).className ?? "";

// Crease's compact File Input layout with a native picker and a separate file list.
export const fileInput = <Message>(
  props: {
    id: string;
    label: string;
    multiple?: boolean;
    disabled?: boolean;
    pending?: boolean;
    error?: string | null;
    onChange: Message;
  },
  h: HtmlBuilder<Message>,
) => {
  const disabled = props.disabled === true || props.pending === true;
  const errorId = `${props.id}-error`;
  return h.div(
    [
      h.DataAttribute("slot", "file-input"),
      h.Class(stylex.props(styles.root).className ?? ""),
    ],
    [
      field(
        props.label,
        h.span(
          [
            h.DataAttribute("slot", "file-input-trigger"),
            ...(disabled ? [h.DataAttribute("disabled", "")] : []),
            h.Class(triggerClassName(!!props.error)),
          ],
          [
            h.input([
              h.Id(props.id),
              h.Type("file"),
              h.Multiple(props.multiple === true),
              h.Disabled(disabled),
              h.OnChange(() => props.onChange),
              h.DataAttribute("slot", "file-input-control"),
              ...(props.error
                ? [h.AriaInvalid(true), h.AriaDescribedBy(errorId)]
                : []),
              h.Class(controlClassName),
            ]),
            outlineIcon(h, [uploadIconPath]),
            h.span(
              [h.AriaHidden(true)],
              [props.multiple ? "Choose files" : "Choose file"],
            ),
          ],
        ),
        h,
      ),
      h.p(
        [
          h.Id(errorId),
          h.Role("alert"),
          h.Class(stylex.props(styles.feedback, styles.error).className ?? ""),
        ],
        props.error ? [props.error] : [],
      ),
      h.p(
        [
          h.Role("status"),
          h.Class(stylex.props(styles.feedback).className ?? ""),
        ],
        props.pending ? ["Reading files…"] : [],
      ),
    ],
  );
};

export const createFileInput = ({
  label,
  accept,
  required = false,
}: {
  label: string;
  accept: string;
  required?: boolean;
}) => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.required = required;
  input.dataset.slot = "file-input-control";
  input.className = controlClassName;

  const caption = document.createElement("output");
  caption.setAttribute("aria-hidden", "true");
  caption.className = stylex.props(styles.fileName).className ?? "";
  caption.defaultValue = "Choose file";
  input.addEventListener("change", () => {
    caption.value = input.files?.[0]?.name ?? caption.defaultValue;
  });

  const svgNamespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(svgNamespace, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svgNamespace, "path");
  path.setAttribute("d", uploadIconPath);
  icon.append(path);

  const trigger = document.createElement("span");
  trigger.dataset.slot = "file-input-trigger";
  trigger.className = triggerClassName();
  trigger.append(input, icon, caption);
  const element = createField({ label, content: trigger, control: input });
  return { element, input };
};
