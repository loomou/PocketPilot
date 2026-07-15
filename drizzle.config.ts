import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dbCredentials: {
    url: "./data/pocketpilot.sqlite",
  },
  dialect: "sqlite",
  out: "./drizzle",
  schema: "./src/storage/schema.ts",
});
