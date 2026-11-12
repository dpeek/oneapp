import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./apps/web/src/server/schema.ts",
  out: "./apps/web/drizzle",
});
