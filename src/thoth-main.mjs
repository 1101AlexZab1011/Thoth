#!/usr/bin/env node
// Thoth's launcher (src/launcher.mjs):
//   install [--no-launch] [--no-pair]   set Thoth up (profile, add-on, icons, app entry) and start it
//   launch                              start Thoth
//   uninstall [--purge]                 remove the app entry (--purge: the profile and its data too)
//   where                               the profile and the Thunderbird it runs on
import { findThunderbird, install, launch, thothDirs, uninstall } from "./launcher.mjs";

const [command = "launch", ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const print = (value) => console.log(JSON.stringify(value, null, 2));
try {
  if (command === "install") print(await install({ launch: !flag("--no-launch"), pair: !flag("--no-pair") }));
  else if (command === "launch") print(await launch());
  else if (command === "uninstall") print(await uninstall({ purge: flag("--purge") }));
  else if (command === "where") print({ ...thothDirs(), thunderbird: await findThunderbird() });
  else { console.error("Usage: thoth-main.mjs [install [--no-launch] [--no-pair] | launch | uninstall [--purge] | where]"); process.exitCode = 2; }
} catch (error) {
  console.error(`Thoth: ${error.message}`);
  process.exitCode = 1;
}
