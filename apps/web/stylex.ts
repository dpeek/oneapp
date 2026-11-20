import { createStylexBunPlugin } from "@stylexjs/unplugin/bun";
import { fileURLToPath } from "node:url";

export const stylexOptions = {
  styleResolution: "property-specificity",
  // Retain imports whose token references become CSS variables.
  treeshakeCompensation: true,
  useCSSLayers: true,
  unstable_moduleResolution: { type: "commonJS" },
} as const;

export default createStylexBunPlugin({
  ...stylexOptions,
  runtimeInjection: true,
  bunDevCssOutput: fileURLToPath(
    new URL("./node_modules/.cache/stylex.dev.css", import.meta.url),
  ),
});
