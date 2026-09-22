import { defineConfig } from "tsdown"

import packageJson from "./package.json" with { type: "json" }

export default defineConfig({
  entry: ["src/main.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,

  define: {
    COPILOT_API_VERSION: JSON.stringify(packageJson.version),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
})
