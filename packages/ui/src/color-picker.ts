// Adapts CreaseUI's Without Alpha example to OneApp's Foldkit and StyleX UI.
import * as stylex from "@stylexjs/stylex";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Mount, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { button } from "./button.ts";
import {
  clamp,
  colorFormats,
  formatColor,
  parseColor,
  type Hsv,
} from "./color-picker-color.ts";
import { input } from "./field.ts";
import { outlineIcon } from "./icons.ts";
import * as Popover from "./popover.ts";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  content: {
    display: "grid",
    gap: "0.75rem",
    inlineSize: "min(16rem, calc(100vw - 4rem))",
  },
  area: {
    position: "relative",
    blockSize: "11rem",
    border: `1px solid ${controls.border}`,
    borderRadius: controls.radius,
    touchAction: "none",
    userSelect: "none",
    cursor: "crosshair",
  },
  areaThumb: {
    position: "absolute",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    inlineSize: "1rem",
    blockSize: "1rem",
    boxSizing: "border-box",
    border: "2px solid white",
    borderRadius: "50%",
    boxShadow: "0 1px 3px rgb(0 0 0 / 55%)",
  },
  swatch: {
    inlineSize: "1rem",
    blockSize: "1rem",
    border: `1px solid ${controls.border}`,
    borderRadius: "0.25rem",
  },
  hueRow: { display: "flex", alignItems: "center", gap: "0.5rem" },
  fields: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    gap: "0.5rem",
  },
  format: {
    border: `1px solid ${controls.border}`,
    borderRadius: controls.radius,
    color: controls.foreground,
    backgroundColor: controls.surface,
    paddingInline: "0.375rem",
    font: "inherit",
  },
  hue: {
    appearance: "none",
    flexGrow: 1,
    minInlineSize: 0,
    blockSize: "1rem",
    margin: 0,
    border: `1px solid ${controls.border}`,
    borderRadius: "999px",
    backgroundImage:
      "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
    cursor: "pointer",
  },
  hueThumb: {
    appearance: {
      "::-webkit-slider-thumb": "none",
      "::-moz-range-thumb": "none",
    },
    inlineSize: {
      "::-webkit-slider-thumb": "0.875rem",
      "::-moz-range-thumb": "0.875rem",
    },
    blockSize: {
      "::-webkit-slider-thumb": "0.875rem",
      "::-moz-range-thumb": "0.875rem",
    },
    borderRadius: {
      "::-webkit-slider-thumb": "50%",
      "::-moz-range-thumb": "50%",
    },
    backgroundColor: {
      "::-webkit-slider-thumb": "#fff",
      "::-moz-range-thumb": "#fff",
    },
    border: {
      "::-webkit-slider-thumb": "1px solid #666",
      "::-moz-range-thumb": "1px solid #666",
    },
  },
});

const Format = Schema.Literals(colorFormats);
const isFormat = Schema.is(Format);
const Hsv = Schema.Struct({
  h: Schema.Number,
  s: Schema.Number,
  v: Schema.Number,
});
export const Model = Schema.Struct({
  color: Hsv,
  format: Format,
  draft: Schema.String,
  popover: Popover.Model,
});
type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  GotPopover: { message: Popover.Message },
  MovedArea: { s: Schema.Number, v: Schema.Number },
  NudgedArea: { s: Schema.Number, v: Schema.Number },
  ChangedHue: { h: Schema.Number },
  ChangedFormat: { format: Format },
  ChangedInput: { text: Schema.String },
  CommittedInput: {},
  PickedFromScreen: {},
  FinishedScreenPick: { value: Schema.NullOr(Schema.String) },
});
type Message = typeof Message.Type;

export const init = (id: string, value: string): Model => {
  const color = parseColor(value) ?? { h: 0, s: 0, v: 0 };
  return {
    color,
    format: "hex",
    draft: formatColor(color, "hex"),
    popover: Popover.init({ id }),
  };
};

export const hex = (model: Model) => formatColor(model.color, "hex");

type EyeDropperConstructor = new () => { open(): Promise<{ sRGBHex: string }> };
const eyeDropper = () =>
  (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;

const PickColor = Command.define("PickOpaqueColorFromScreen", {
  messages: [Message.FinishedScreenPick],
  execute: Effect.promise(async () => {
    try {
      const Picker = eyeDropper();
      const result = Picker ? await new Picker().open() : null;
      return Message.FinishedScreenPick({ value: result?.sRGBHex ?? null });
    } catch {
      return Message.FinishedScreenPick({ value: null });
    }
  }),
});

const SetColorArea = Mount.defineStream("SetOpaqueColorArea", {
  messages: [Message.MovedArea],
  execute: ({ element }) => {
    if (!(element instanceof HTMLElement)) return Stream.empty;
    return Stream.callback<typeof Message.MovedArea.Type>((queue) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const send = ({ clientX, clientY }: PointerEvent) => {
              const rect = element.getBoundingClientRect();
              if (!rect.width || !rect.height) return;
              Queue.offerUnsafe(
                queue,
                Message.MovedArea({
                  s: clamp((clientX - rect.left) / rect.width),
                  v: clamp(1 - (clientY - rect.top) / rect.height),
                }),
              );
            };
            const start = (event: PointerEvent) => {
              if (
                !event.isPrimary ||
                event.button !== 0 ||
                element.getAttribute("aria-disabled") === "true"
              )
                return;
              event.preventDefault();
              element.focus({ preventScroll: true });
              element.setPointerCapture(event.pointerId);
              send(event);
            };
            const move = (event: PointerEvent) => {
              if (element.hasPointerCapture(event.pointerId)) send(event);
            };
            element.addEventListener("pointerdown", start);
            element.addEventListener("pointermove", move);
            element.addEventListener("pointerup", move);
            return () => {
              element.removeEventListener("pointerdown", start);
              element.removeEventListener("pointermove", move);
              element.removeEventListener("pointerup", move);
            };
          }),
          (cleanup) => Effect.sync(cleanup),
        );
        return yield* Effect.never;
      }),
    );
  },
});

const toPopover = (message: typeof Popover.Message.Type) =>
  Message.GotPopover({ message });
const foldPopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.popover),
  write: (model, popover) => ({ ...model, popover }),
  toParentMessage: toPopover,
  foldOutMessage: () => (model) => ({ model }),
});

const format = (model: Model, color: Hsv = model.color): Model => ({
  ...model,
  color,
  draft: formatColor(color, model.format),
});

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotPopover: ({ message }) => foldPopover(model, message),
    MovedArea: ({ s, v }) => ({
      model: format(model, { ...model.color, s, v }),
    }),
    NudgedArea: ({ s, v }) => ({
      model: format(model, {
        ...model.color,
        s: clamp(model.color.s + s),
        v: clamp(model.color.v + v),
      }),
    }),
    ChangedHue: ({ h }) => ({ model: format(model, { ...model.color, h }) }),
    ChangedFormat: ({ format: next }) => ({
      model: format({ ...model, format: next }),
    }),
    ChangedInput: ({ text }) => ({
      model: { ...model, draft: text, color: parseColor(text) ?? model.color },
    }),
    CommittedInput: () => ({ model: format(model) }),
    PickedFromScreen: () => ({ model, commands: [PickColor()] }),
    FinishedScreenPick: ({ value }) => ({
      model: format(
        model,
        value ? (parseColor(value) ?? model.color) : model.color,
      ),
    }),
  });

const areaKeys: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowDown: [0, -1],
  ArrowUp: [0, 1],
};

export const view = <ParentMessage>(
  props: {
    model: Model;
    label: string;
    disabled: boolean;
    toParentMessage: (message: Message) => ParentMessage;
  },
  h: HtmlBuilder<ParentMessage>,
) => {
  const { model, label, disabled, toParentMessage: send } = props;
  const { h: hue, s, v } = model.color;
  const color = hex(model);
  const saturation = Math.round(s * 100);
  const brightness = Math.round(v * 100);
  return Popover.view(
    {
      model: model.popover,
      label,
      disabled,
      trigger: h.span(
        [
          h.Class(stylex.props(styles.swatch).className ?? ""),
          h.Style({ backgroundColor: color }),
          h.AriaHidden(true),
          h.DataAttribute("slot", "color-picker-swatch"),
        ],
        [],
      ),
      toParentMessage: (message) => send(toPopover(message)),
      content: h.div(
        [h.Class(stylex.props(styles.content).className ?? "")],
        [
          h.div(
            [
              h.Class(stylex.props(styles.area).className ?? ""),
              h.DataAttribute("slot", "color-picker-area"),
              h.Dir("ltr"),
              h.Role("slider"),
              h.Tabindex(disabled ? -1 : 0),
              h.AriaLabel("Saturation and brightness"),
              h.AriaDisabled(disabled),
              h.AriaValuemin(0),
              h.AriaValuemax(100),
              h.AriaValuenow(saturation),
              h.AriaValuetext(
                `${saturation}% saturation, ${brightness}% brightness`,
              ),
              h.Style({
                backgroundColor: `hsl(${hue}, 100%, 50%)`,
                backgroundImage:
                  "linear-gradient(to top, black, transparent), linear-gradient(to right, white, transparent)",
              }),
              h.OnMount(Mount.mapMessage(SetColorArea(), send)),
              h.OnKeyDownPreventDefault((key, modifiers) => {
                const delta = areaKeys[key];
                if (
                  !delta ||
                  disabled ||
                  modifiers.altKey ||
                  modifiers.ctrlKey ||
                  modifiers.metaKey
                )
                  return Option.none();
                const step = modifiers.shiftKey ? 0.1 : 0.01;
                return Option.some(
                  send(
                    Message.NudgedArea({
                      s: delta[0] * step,
                      v: delta[1] * step,
                    }),
                  ),
                );
              }),
            ],
            [
              h.span(
                [
                  h.Class(stylex.props(styles.areaThumb).className ?? ""),
                  h.Style({
                    left: `${s * 100}%`,
                    top: `${(1 - v) * 100}%`,
                    backgroundColor: color,
                  }),
                  h.AriaHidden(true),
                ],
                [],
              ),
            ],
          ),
          h.div(
            [h.Class(stylex.props(styles.hueRow).className ?? "")],
            [
              ...(typeof window !== "undefined" && eyeDropper()
                ? [
                    button(
                      {
                        variant: "outline",
                        size: "icon-sm",
                        disabled,
                        ariaLabel: "Pick a colour from the screen",
                        onClick: send(Message.PickedFromScreen()),
                        children: [
                          outlineIcon(h, [
                            "m14 6 4 4m-6-2 4 4M4 20l1-5L17 3a2.1 2.1 0 0 1 3 3L8 18z",
                          ]),
                        ],
                      },
                      h,
                    ),
                  ]
                : []),
              h.input([
                h.Type("range"),
                h.Min("0"),
                h.Max("360"),
                h.Step("1"),
                h.Value(String(Math.round(hue))),
                h.AriaLabel("Hue"),
                h.Dir("ltr"),
                h.Disabled(disabled),
                h.DataAttribute("slot", "color-picker-hue"),
                h.Class(
                  stylex.props(styles.hue, styles.hueThumb).className ?? "",
                ),
                h.OnInput((value) =>
                  send(Message.ChangedHue({ h: Number(value) })),
                ),
              ]),
            ],
          ),
          h.div(
            [h.Class(stylex.props(styles.fields).className ?? "")],
            [
              h.select(
                [
                  h.Class(stylex.props(styles.format).className ?? ""),
                  h.Value(model.format),
                  h.AriaLabel("Colour format"),
                  h.Disabled(disabled),
                  h.OnChange((value) =>
                    send(
                      Message.ChangedFormat({
                        format: isFormat(value) ? value : "hex",
                      }),
                    ),
                  ),
                ],
                colorFormats.map((value) =>
                  h.option([h.Value(value)], [value.toUpperCase()]),
                ),
              ),
              input(
                [
                  h.Type("text"),
                  h.Value(model.draft),
                  h.AriaLabel("Colour value"),
                  h.Disabled(disabled),
                  h.Spellcheck(false),
                  h.Autocomplete("off"),
                  h.OnInput((text) => send(Message.ChangedInput({ text }))),
                  h.OnBlur(send(Message.CommittedInput())),
                  h.OnKeyDownPreventDefault((key) =>
                    key === "Enter"
                      ? Option.some(send(Message.CommittedInput()))
                      : Option.none(),
                  ),
                ],
                h,
              ),
            ],
          ),
        ],
      ),
    },
    h,
  );
};
