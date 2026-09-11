# Feugee Studio — After Effects Plugins

Official CEP extension suite for Adobe After Effects by **Feugee Studio**.

<!-- TABLE -->
| Plugin | Version | Payload | Download |
|---|---|---|---|
| **Knowledge Nuke** | `v3.3.6` | 6 files | installer script |
| **SideQuest** | `v1.6.6` | 8 files | installer script |
| **Feugelign** | `v1.4.6` | 8 files | installer script |
| **Feugee Motion** | `v1.2.6` | 8 files | installer script |
<!-- /TABLE -->

---
## Install

**macOS** — Choose one of the two options:

- **Option 1 — Terminal One-Liner (Recommended & fast):**
  Quit After Effects, open Terminal, paste this command and press Return:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/install/Install-Feugee-Plugins.command | bash
  ```

- **Option 2 — Double-click installer (GUI):**
  1. Quit After Effects.
  2. Download and unzip [`install/Install-Feugee-Plugins.zip`](install/Install-Feugee-Plugins.zip) *(the `.zip` preserves macOS executable permissions)*.
  3. Right-click `Install-Feugee-Plugins.command` → **Open** → **Open** (first run only, Gatekeeper asks once).
  4. Wait for `4/4 plugins installed`.
  5. Open After Effects → **Window › Extensions › [Plugin Name]**.

**Windows** — Choose one of the two options:

- **Option 1 — PowerShell one-liner (Recommended & fast):**
  Quit After Effects, open **PowerShell**, paste this command and press Enter:
  ```powershell
  irm https://raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/install/Install-Feugee-Plugins.ps1 | iex
  ```

- **Option 2 — Double-click installer (GUI):**
  1. Quit After Effects.
  2. Download [`install/Install-Feugee-Plugins.bat`](install/Install-Feugee-Plugins.bat) *(right-click → **Save link as…**)*.
  3. Double-click it. If SmartScreen warns, choose **More info → Run anyway** — the installer is unsigned.
  4. Wait for `4/4 plugins installed`.
  5. Open After Effects → **Window › Extensions › [Plugin Name]**.

  No administrator rights needed. The `.bat` downloads the PowerShell installer
  itself, so it works on its own; if you cloned the repo it runs the local
  `Install-Feugee-Plugins.ps1` next to it instead.

The installer writes into the **per-user** CEP folder
(`~/Library/Application Support/Adobe/CEP/extensions` on macOS,
`%APPDATA%\Adobe\CEP\extensions` on Windows) and turns on CEP
`PlayerDebugMode`. Both are required for live updates: After Effects cannot
write to the system-wide folder a ZXP installer uses, and a panel patched in
place no longer matches its ZXP signature.

---

## Automatic updates

Every panel checks this repo on launch.

- An update is published → an **orange dot** appears on the update button.
- Click it → the panel downloads the new files, writes them in place, verifies
  each one, and reloads the webview and ExtendScript host in 1–2 seconds.
- No After Effects restart, no ZXP reinstall.

If a write fails halfway, the previous version is restored automatically —
the panel is never left half-updated.

### When an update fails

The status bar shows the reason. For the full story:

**Alt+click** (or right-click) the update button → runs diagnostics and opens
`feugee-update.log`, which lists the extension path, write access, which
mirror answered, and the exact failure. That log is what to send when asking
for help.

Common causes:

| Status message | What it means | Fix |
|---|---|---|
| `plugin folder is read-only` | Installed system-wide by a ZXP installer | Run the installer script above |
| `download failed - … HTTP 403` | GitHub API rate limit on the studio IP | Retry; the panel no longer uses that API |
| `write failed on <file>` | Antivirus or a permissions issue | Run the installer script above |

---

## Repair / reinstall

Run the same installer script — it is idempotent. It overwrites the plugin
files with the current published version, rewrites `.debug`, re-enables
`PlayerDebugMode`, and warns if an old system-wide copy is still shadowing the
user copy.

If both copies exist, After Effects may keep loading the old one. Delete the
system copy once:

macOS:

```bash
sudo rm -rf "/Library/Application Support/Adobe/CEP/extensions/com.feugee.feugelign"
```

Windows — in an **Administrator** PowerShell:

```powershell
Remove-Item -Recurse -Force "${env:CommonProgramFiles(x86)}\Adobe\CEP\extensions\com.feugee.feugelign"
```

Both installers print the exact paths they found, so you can paste straight
from their output.

---

## Manual install

Works on both platforms, no scripts.

1. Quit After Effects.
2. Download `bundles/<slug>.json` for the plugin you want.
3. Create the folder `<CEP extensions>/<bundleId>` where `<CEP extensions>` is
   `~/Library/Application Support/Adobe/CEP/extensions` (macOS) or
   `%APPDATA%\Adobe\CEP\extensions` (Windows).
4. Every key in the JSON `files` object is a relative path and every value is
   that file's content — write them out as UTF-8.
5. Enable unsigned extensions:
   - macOS: `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` — repeat for
     each CSXS version your AE uses; 9–26 covers CC 2019 → 2026.
   - Windows: add a string value `PlayerDebugMode = 1` under
     `HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.12` (same version range).

| Plugin | slug | bundleId |
|---|---|---|
| Knowledge Nuke | `knowledgenuke` | `com.feugee.knowledgenuke` |
| SideQuest | `sidequest` | `com.feugee.sidequest` |
| Feugelign | `feugelign` | `com.feugee.feugelign` |
| Feugee Motion | `feugeemotion` | `com.feugee.motion` |

---

## Publishing an update (maintainer)

```bash
python3 tools/build.py --set feugelign=1.3.1 --sync-modes
git add -A && git commit -m "release: feugelign v1.3.1" && git push
```

`tools/build.py` bumps `CSXS/manifest.xml` and the version badge in
`index.html`, copies the canonical `Feugelign_CEP/js/modes.js` into every
plugin, regenerates `bundles/*.json` and `updates.json`, and refreshes the
table above. Panels pick the update up on their next launch.

## Tests

```bash
node tools/tests/test-updater.js            # detect, install, rollback, offline
node tools/tests/test-extendscript-path.js  # ExtendScript write path + chunking
```

Both run without After Effects: the CEP filesystem and the manifest fetch are
faked, the ExtendScript snippets are parsed and their file writes emulated.
