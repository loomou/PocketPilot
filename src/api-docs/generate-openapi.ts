import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildMobileOpenApiDocument } from "./mobile-openapi.js";

const outputPath = resolve(process.cwd(), "dist/openapi/mobile-v1.json");
const document = await buildMobileOpenApiDocument();

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
