// Release builds: the add-on's version is the tag's (vX.Y.Z), so Thoth's update check sees an
// installed release as current. Usage: node scripts/stamp-version.mjs v2.15.0
import { readFile, writeFile } from "node:fs/promises";

const version = String(process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`The tag must look like v2.15.0, not "${process.argv[2] ?? process.env.GITHUB_REF_NAME}"`);
const file = new URL("../thunderbird-addon/manifest.json", import.meta.url);
const text = await readFile(file, "utf8");
await writeFile(file, text.replace(/"version": "[^"]+"/, `"version": "${version}"`));
console.log(`add-on version ${version}`);
