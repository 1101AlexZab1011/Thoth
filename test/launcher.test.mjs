import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDON_ID, profileUuid, thothDirs, userJs, writeIcns, writeIco } from "../src/launcher.mjs";

test("Thoth's profile preferences enable the add-on, fix its origin and drop Thunderbird's extras", () => {
  const text = userJs("11111111-2222-3333-4444-555555555555");
  assert.match(text, /user_pref\("extensions\.autoDisableScopes", 0\);/);
  assert.match(text, /user_pref\("mailnews\.start_page\.enabled", false\);/);
  assert.match(text, /user_pref\("mail\.shell\.checkDefaultClient", false\);/);
  assert.match(text, /user_pref\("mail\.provider\.suppress_dialog_on_startup", true\);/);
  assert.ok(text.includes(ADDON_ID) && text.includes("11111111-2222-3333-4444-555555555555"));
});

test("a reinstall keeps the add-on's origin (its pairing stays valid)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thoth-"));
  try {
    await writeFile(join(dir, "user.js"), userJs("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
    assert.equal(await profileUuid(dir), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.match(await profileUuid(join(dir, "none")), /^[0-9a-f-]{36}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the profile lives in Thoth's own folder", () => {
  const { base, profile } = thothDirs();
  assert.ok(profile.startsWith(base) && /thoth/i.test(base));
});

test("icons for Windows (.ico) and macOS (.icns) are well formed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thoth-icons-"));
  try {
    await writeIco(join(dir, "t.ico"));
    const ico = await readFile(join(dir, "t.ico"));
    assert.equal(ico.readUInt16LE(2), 1);
    const count = ico.readUInt16LE(4);
    assert.equal(count, 7);
    const last = 6 + 16 * (count - 1);
    assert.equal(ico.readUInt32LE(last + 12) + ico.readUInt32LE(last + 8), ico.length);
    await writeIcns(join(dir, "t.icns"));
    const icns = await readFile(join(dir, "t.icns"));
    assert.equal(icns.toString("ascii", 0, 4), "icns");
    assert.equal(icns.readUInt32BE(4), icns.length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
