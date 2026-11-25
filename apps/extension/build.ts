import { createStylexBunPlugin } from "@stylexjs/unplugin/bun";
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stylexOptions } from "../../scripts/stylex-options.ts";

const source = new URL("./src/", import.meta.url);
const output = new URL("./dist/", import.meta.url);
const stylexCss = new URL("stylex.css", output);

await Bun.build({
  entrypoints: [fileURLToPath(new URL("popup.html", source))],
  outdir: fileURLToPath(output),
  target: "browser",
  minify: true,
  throw: true,
  plugins: [
    createStylexBunPlugin({
      ...stylexOptions,
      dev: false,
      bunDevCssOutput: fileURLToPath(stylexCss),
    }),
  ],
});

const popup = new URL("popup.html", output);
const popupHtml = await Bun.file(popup).text();
await Bun.write(
  popup,
  popupHtml.replace(
    "</head>",
    '<link rel="stylesheet" href="./stylex.css"></head>',
  ),
);

await Bun.build({
  entrypoints: [fileURLToPath(new URL("background.ts", source))],
  outdir: fileURLToPath(output),
  target: "browser",
  minify: true,
  throw: true,
});

await Bun.write(
  new URL("manifest.json", output),
  Bun.file(new URL("manifest.json", source)),
);
await cp(new URL("icons/", source), new URL("icons/", output), {
  recursive: true,
});
