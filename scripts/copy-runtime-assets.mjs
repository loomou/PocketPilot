import { cp } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);

await cp(
  new URL("drizzle/", projectRoot),
  new URL("dist/drizzle/", projectRoot),
  { force: true, recursive: true },
);
