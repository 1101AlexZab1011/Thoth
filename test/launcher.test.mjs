import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDON_ID, THOTH_APP_ID, profileUuid, thothDirs, userJs, windowsShortcutScript, writeIcns, writeIco } from "../src/launcher.mjs";

test("Windows shortcuts carry the taskbar id the add-on gives Thoth's windows", async () => {
  const links = ["C:\\Start Menu\\Thoth.lnk", "C:\\Desktop\\Thoth.lnk"];
  const script = windowsShortcutScript({ thunderbird: "C:\\TB\\thunderbird.exe", profile: "C:\\Thoth\\Profile", ico: "C:\\Thoth\\thoth.ico", links });
  for (const lnk of links) assert.ok(script.includes(`[ThothShortcut]::SetAppId('${lnk}', '${THOTH_APP_ID}')`));
  const experiment = await readFile(new URL("../thunderbird-addon/experiments/workspace/implementation.js", import.meta.url), "utf8");
  assert.equal(experiment.match(/const THOTH_APP_ID = "([^"]+)"/)?.[1], THOTH_APP_ID);
});

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
    // As Windows' own icons are: bitmaps up to 128 px, PNG at 256.
    for (let i = 0; i < count - 1; i++) {
      const at = ico.readUInt32LE(6 + 16 * i + 12), size = ico[6 + 16 * i];
      assert.equal(ico.readUInt32LE(at), 40, `${size} px is a bitmap`);
      assert.deepEqual([ico.readInt32LE(at + 4), ico.readInt32LE(at + 8), ico.readUInt16LE(at + 14)], [size, size * 2, 32]);
      const alpha = Array.from({ length: size * size }, (_, p) => ico[at + 40 + p * 4 + 3]);
      assert.ok(alpha.some((a) => a === 255) && alpha.some((a) => a === 0), `${size} px keeps its transparency`);
    }
    assert.equal(ico.readUInt32BE(ico.readUInt32LE(last + 12)), 0x89504e47, "256 px is a PNG");
    await writeIcns(join(dir, "t.icns"));
    const icns = await readFile(join(dir, "t.icns"));
    assert.equal(icns.toString("ascii", 0, 4), "icns");
    assert.equal(icns.readUInt32BE(4), icns.length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
