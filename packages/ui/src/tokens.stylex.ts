import * as stylex from "@stylexjs/stylex";

export const controls = stylex.defineVars({
  primary: "var(--primary)",
  primaryHover: "var(--primary-hover)",
  onPrimary: "var(--on-primary)",
  destructive: "var(--destructive)",
  destructiveHover: "var(--destructive-hover)",
  onDestructive: "var(--on-destructive)",
  surface: "var(--surface)",
  card: "var(--card)",
  mutedSurface: "var(--muted-surface)",
  popover: "var(--popover)",
  foreground: "var(--text)",
  mutedForeground: "var(--muted)",
  border: "var(--border)",
  hover: "var(--hover)",
  selected: "var(--selected)",
  focus: "var(--focus)",
  radius: "var(--control-radius)",
  pillRadius: "var(--control-pill-radius)",
});

export const alertColors = stylex.defineVars({
  info: "var(--alert-info)",
  success: "var(--alert-success)",
  warning: "var(--alert-warning)",
  error: "var(--alert-error)",
});
