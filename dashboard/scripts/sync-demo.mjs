import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../public/demo/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const source of ["test/human_contracts/ea026411904ex10-9.htm", "test/human_contracts/nav-cashier-addendum.md", "test/human_contracts/short-fund-agreement.md", "examples/rwa-cashier-config.json"]) {
  const filename = source.split("/").at(-1);
  await copyFile(new URL(`../../${source}`, import.meta.url), new URL(filename, destination));
  console.log(`demo:sync ${filename}`);
}
