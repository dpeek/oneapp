import * as stylex from "@stylexjs/stylex";

export const controls = stylex.defineVars({
  primary: "var(--accent)",
  primaryHover: "var(--accent-hover)",
  onPrimary: "var(--on-accent)",
  surface: "var(--surface)",
  foreground: "var(--text)",
  mutedForeground: "var(--muted)",
  border: "var(--border)",
  hover: "var(--selected)",
  focus: "var(--accent)",
  radius: "var(--control-radius)",
});
