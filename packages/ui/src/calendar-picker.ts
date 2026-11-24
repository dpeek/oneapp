import { Calendar } from "@foldkit/ui";
import { Option, Predicate } from "effect";
import type { CalendarDate as FoldkitDate } from "foldkit/calendar";
import type { ChildAttribute, HtmlBuilder } from "foldkit/html";
import { buttonClassName } from "./button.ts";
import { outlineIcon } from "./icons.ts";

export const { Model, Message, init, update, focusDate, dropToDays } = Calendar;
export type CalendarDate = FoldkitDate;

const dayKeys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Enter",
  " ",
]);

// Crease UI's Calendar composition using OneApp controls and a compact grid.
export const view = <Message>(
  props: {
    model: typeof Model.Type;
    selectedDate: CalendarDate;
    weekStart: CalendarDate | null;
    toParentMessage: (message: typeof Calendar.Message.Type) => Message;
  },
  h: HtmlBuilder<Message>,
) =>
  h.submodel({
    slotId: props.model.id,
    model: props.model,
    view: Calendar.view,
    toParentMessage: props.toParentMessage,
    viewInputs: {
      maybeSelectedDate: Option.some(props.selectedDate),
      toView: (attributes) => {
        const jump = (
          direction: "previous" | "next",
          attrs: readonly ChildAttribute[],
        ) =>
          h.button(
            [
              ...attrs,
              h.DataAttribute("slot", "button"),
              h.Class(buttonClassName({ variant: "ghost", size: "icon-sm" })),
            ],
            [
              outlineIcon(h, [
                direction === "previous" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6",
              ]),
            ],
          );

        return h.div(
          [
            ...attributes.root,
            h.DataAttribute("slot", "calendar"),
            h.Class("calendar-picker"),
          ],
          [
            h.div(
              [h.Class("calendar-picker-caption")],
              [
                attributes._tag === "Years"
                  ? h.span(
                      [h.Id(attributes.heading.id)],
                      [attributes.heading.text],
                    )
                  : h.button(
                      [
                        ...attributes.headingButton,
                        h.Id(attributes.heading.id),
                        h.DataAttribute("slot", "button"),
                        h.Class(
                          buttonClassName({ variant: "ghost", size: "sm" }),
                        ),
                      ],
                      [
                        attributes.heading.text,
                        outlineIcon(h, ["m6 9 6 6 6-6"]),
                      ],
                    ),
                h.div(
                  [h.Class("calendar-picker-arrows")],
                  attributes._tag === "Days"
                    ? [
                        jump("previous", attributes.previousMonthButton),
                        jump("next", attributes.nextMonthButton),
                      ]
                    : attributes._tag === "Years"
                      ? [
                          jump("previous", attributes.previousPageButton),
                          jump("next", attributes.nextPageButton),
                        ]
                      : [],
                ),
              ],
            ),
            attributes._tag === "Days"
              ? h.div(
                  [
                    ...attributes.grid.filter(
                      ({ attribute }) =>
                        !Predicate.isTagged(
                          attribute,
                          "OnKeyDownPreventDefault",
                        ),
                    ),
                    h.Class("calendar-picker-days"),
                    // Resolve Enter against the current cursor after queued arrow presses.
                    h.OnKeyDownPreventDefault((key, modifiers) =>
                      dayKeys.has(key)
                        ? Option.some(
                            props.toParentMessage(
                              Calendar.Message.PressedKeyOnGrid({
                                key,
                                isShift: modifiers.shiftKey,
                              }),
                            ),
                          )
                        : Option.none(),
                    ),
                  ],
                  [
                    h.div(
                      [
                        ...attributes.headerRow,
                        h.Class("calendar-picker-weekdays"),
                      ],
                      attributes.columnHeaders.map(({ name, attributes }) =>
                        h.div([...attributes], [name]),
                      ),
                    ),
                    ...attributes.weeks.map((week) => {
                      const first = week.cells[0]?.date;
                      const start = props.weekStart;
                      return h.div(
                        [
                          ...week.attributes,
                          h.Class("calendar-picker-week"),
                          ...(first &&
                          start &&
                          first.year === start.year &&
                          first.month === start.month &&
                          first.day === start.day
                            ? [h.DataAttribute("visible-week", "")]
                            : []),
                        ],
                        week.cells.map((cell) =>
                          h.div(
                            [...cell.cellAttributes],
                            [
                              h.button(
                                [
                                  ...cell.buttonAttributes,
                                  h.DataAttribute("slot", "calendar-day"),
                                ],
                                [cell.label],
                              ),
                            ],
                          ),
                        ),
                      );
                    }),
                  ],
                )
              : h.div(
                  [...attributes.grid, h.Class("calendar-picker-periods")],
                  attributes.cells.map((cell) =>
                    h.div(
                      [...cell.cellAttributes],
                      [
                        h.button(
                          [
                            ...cell.buttonAttributes,
                            h.DataAttribute("slot", "calendar-period"),
                          ],
                          ["shortLabel" in cell ? cell.shortLabel : cell.label],
                        ),
                      ],
                    ),
                  ),
                ),
          ],
        );
      },
    },
  });
