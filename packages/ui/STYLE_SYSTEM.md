# Components and style system

Use Crease UI's StyleX components as the reference for OneApp. Keep reusable
component styles and states in StyleX, and use OneApp's shared typed tokens for
their theme values. Apply this pattern as each workflow is updated.

## Compose with Crease

- Start with the components exported by [`@oneapp/ui`](src/index.ts). For a missing
  component or variant, start from the Crease StyleX source at the revision in
  [Third-party notices](THIRD_PARTY_NOTICES.md). Follow its slots, defaults, and
  interaction behavior. Check the installed Foldkit API when adapting a primitive.
- Keep shared component variations in `packages/ui`. Use the existing variant or
  size when it fits. A feature can compose components and control their placement
  in the page.
- Prefer the shared Field and styled native controls for ordinary forms. Preserve
  labels, accessible names, form submission, autocomplete, and any date or file
  semantics when changing a control.

## Theme and tokens

In StyleX, reference the semantic roles from [`tokens.stylex.ts`](src/tokens.stylex.ts).
Use roles such as `controls.surface`, `controls.border`, and `controls.focus` so
components respond to the same theme. When a reusable role is missing, add it to
the shared token module and map it to a CSS custom property. Define light and dark
values in [shared theme CSS](src/theme.css). The web app, MCP consent page, and
extension popup all load this theme. Use separate roles for primary actions,
keyboard focus, hover, selection, and status.

Aim for the restrained look of the Macro reference. Use neutral surfaces, subtle
borders, readable text, and one prominent primary action. Start with Crease's
component spacing and radius. Keep keyboard focus clearly visible. Tune color
and other theme values centrally so dialogs, menus, and inputs stay consistent.
Review app-wide theme changes across surfaces in their own change.

## Where styles live

| Style | Home |
| --- | --- |
| Component appearance, sizes, variants, focus, hover, selected and disabled states | StyleX in `packages/ui` |
| Theme values, document defaults, and resets | Theme and root CSS |
| Feature layout, responsive columns, and placement of components on a screen | Feature CSS using shared variables where needed |
| Per-instance values such as a Calendar event's time position | CSS custom properties set by the view |

When adopting a shared control, remove local rules it supersedes and check global
fallback selectors against the rendered `data-slot`. For example, the Create
search field has a StyleX focus treatment and also matches the global fallback
for inputs whose slot differs from `input`. Give the component a single visible
focus treatment as part of that migration.

## Dialogs and feedback

- Use the shared Dialog pattern for modal forms and Crease Command for searchable
  action choosers. Keep the required action clear. Check initial focus, Escape,
  pending operations, and focus restoration. Test the transition between Create
  and Add task and ensure nested controls get first use of Escape when appropriate.
- Put validation beside its field and keep persistent workflow errors near their
  recovery action. Use AlertDialog when a consequential action needs confirmation.
  Use the [shared feedback policy](README.md#toast-notifications) for toasts and
  announce each outcome once.

Verify the changed surface in light and dark mode, with the keyboard, and at
narrow widths. When touching StyleX build wiring, check the packaged output. The
web app compiles StyleX in Vite and Bun. A surface adopting shared components needs
to ship the generated CSS, including the extension popup when it adopts them.
