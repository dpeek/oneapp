# Components and style system

Use Crease UI's StyleX components as the reference for Orumai. Keep reusable
component styles and states in StyleX, and use Orumai's shared typed tokens for
their theme values. Apply this pattern as each workflow is updated.

## Compose with Crease

- Start with the components exported by [`@orumai/ui`](src/index.ts). For a missing
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

Use `controls.pillRadius` for buttons and single-line field borders. Use
`controls.radius` for rows, overlays, and multiline field borders that use the
shared corner radius.

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

## Workspace screen headers

- Compose the web app's `screenHeader` in [`workspace.ts`](../../apps/web/src/workspace.ts).
  It uses the compact, transparent Crease Toolbar layout. Put the back link or
  navigation trigger, the `h1`, then view controls such as filters and sort in
  the start slot. The title truncates when space is tight, and the controls stay
  visible. Use the view controls slot for groups such as date navigation and
  view switches that can wrap below the heading. Keep DOM order aligned with
  visual order at every width.
- Put a single small rounded primary Button at the far end, including on the
  first-use empty screen. Use a plus icon and a noun as the visible label
  and a descriptive accessible name such as “Add task” or “Upload file”. Use
  the same Button styles with a native file input when the action opens a file
  chooser. Use small rounded ghost controls for secondary actions, with an
  accessible name for each icon-only control. Allow 44px targets on coarse
  pointers.
- Reuse the web app's [`filter-menu.ts`](../../apps/web/src/filter-menu.ts)
  for the filter icon, selected count, and Clear action. Keep text feedback
  below the action row. Screen headers use native Tab order. Reserve roving
  focus for a control group that implements the full toolbar keyboard pattern
  and keeps arrow keys inside nested menus while they're in use.

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
