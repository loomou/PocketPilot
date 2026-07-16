import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    cli: "src/cli.ts",
    "generate-openapi": "src/api-docs/generate-openapi.ts",
  },
  format: ["esm"],
  platform: "node",
  shims: true,
  sourcemap: true,
  target: "node24",
});
