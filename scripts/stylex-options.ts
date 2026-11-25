export const stylexOptions = {
  styleResolution: "property-specificity",
  // Retain imports whose token references become CSS variables.
  treeshakeCompensation: true,
  useCSSLayers: true,
  unstable_moduleResolution: { type: "commonJS" },
} as const;
