import app from "./src/index.html";

const server = Bun.serve({
  routes: { "/*": app },
  // Foldkit uses Vite's custom HMR events, which Bun's dev server cannot handle.
  development: { hmr: false, console: true },
});

console.log(`OneApp development server at ${server.url}`);
