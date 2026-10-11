import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ["pica/dist/pica.min.mjs", "pica.mjs"],
  ["pica/LICENSE", "pica-LICENSE.txt"],
];
await mkdir(path.join(root, "public/vendor"), { recursive:true });
for (const [source,destination] of files) await copyFile(path.join(root,"node_modules",source),path.join(root,"public/vendor",destination));
process.stdout.write("Browser tools and licenses refreshed.\n");
