import * as stylex from "@stylexjs/stylex";

export const controls = stylex.defineVars({
  primary: "var(--accent)",
  primaryHover: "var(--accent-hover)",
  onPrimary: "var(--on-accent)",
  destructive: "var(--destructive)",
  destructiveHover: "var(--destructive-hover)",
  onDestructive: "var(--on-destructive)",
  surface: "var(--surface)",
  popover: "var(--popover)",
  foreground: "var(--text)",
  mutedForeground: "var(--muted)",
  border: "var(--border)",
  hover: "var(--selected)",
  focus: "var(--accent)",
  radius: "var(--control-radius)",
});

export const alertColors = stylex.defineVars({
  info: "var(--alert-info)",
  success: "var(--alert-success)",
  warning: "var(--alert-warning)",
  error: "var(--alert-error)",
});
