declare module "cloudflare:workers" {
  export const DurableObject: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.DurableObject;
}

declare module "@resvg/resvg-wasm/index_bg.wasm" {
  const wasm: WebAssembly.Module;
  export default wasm;
}

declare module "@cf-wasm/photon/photon.wasm" {
  const wasm: WebAssembly.Module;
  export default wasm;
}
