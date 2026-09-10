# Feugee Plugins — Architecture & Development Guide

Dokumentasi arsitektur, standar teknis, dan panduan membuat plugin baru di suite **Feugee Studio CEP Extensions**.

---

## 1. Arsitektur Shared Core (`modes.js` & `panel.css`)

Semua plugin Feugee menggunakan dua file inti yang **byte-identical**:
- `Feugelign_CEP/css/panel.css` (Canonical CSS)
- `Feugelign_CEP/js/modes.js` (Canonical JS Controller)

Setiap plugin mengikutsertakannya di `index.html`:
```html
<link rel="stylesheet" href="css/panel.css">
...
<script src="js/panel.js"></script>
<script src="js/modes.js"></script>
```

### Fitur yang Otomatis Aktif di Setiap Plugin Baru:
1. **Light / Dark Mode Toggle (`#btnTheme`):**
   - Tombol Sun/Moon disematkan otomatis di `.topbar`.
   - Mengubah atribut `data-theme="light"` / `data-theme="dark"` di `<html>` dan `<body>`.
   - State disimpan di `localStorage.getItem("feugee.theme")`.
   - Event `window.addEventListener("storage", ...)` memastikan pergantian tema di satu panel otomatis mengubah semua panel Feugee lain yang sedang terbuka secara real-time.
   - Variabel CSS adaptif di `panel.css`:
     - Dark: `--bg: #161619`, `--card: #1e1e22`, `--tile: #26262c`, `--field: #121215`, `--stroke: #34343d`, `--text: #f1f1f4`.
     - Light: `--bg: #f0f1f5`, `--card: #ffffff`, `--tile: #e6e7ec`, `--field: #ffffff`, `--stroke: #cbccd6`, `--text: #18181c`.

2. **View Modes (Full ↔ Compact):**
   - Mode Compact dibangun secara dinamis dari DOM Full view (`.tile[data-act]` dan `.tile.mode`).
   - Tidak perlu membuat tree markup HTML kedua.
   - Nilai input text dan checkbox di-mirror dua arah secara otomatis.

3. **Reload Plugin (`#btnReload`):**
   - Sekali klik mengevaluasi ulang `jsx/host.jsx` via ExtendScript (`$.evalFile`) lalu me-reload webview tanpa perlu restart After Effects.

4. **Auto-Update v2 Live In-Place Installer (`#btnUpdate`):**
   - **Zero-Delay Commit Resolution:** Mengambil commit SHA langsung dari `https://github.com/royalecreativelab/feugee-plugins/commits/main.atom` (`cache-control: max-age=0`), membypass cache 300 detik Fastly CDN.
   - **Pre-flight Write Check:** Memeriksa permission tulis folder plugin (`.feugee-write-test`) sebelum mendownload payload.
   - **Atomic Verification & Rollback:** File di-backup di memori. Jika penulisan file gagal atau isi file tidak identik saat diverifikasi ulang, semua file di-restore dari backup RAM.
   - **Unsigned Mode & Debug Port:** Menghapus `META-INF/signatures.xml`, menulis `.debug`, dan mengaktifkan `PlayerDebugMode 1` (macOS via `defaults write` / Windows via registry).
   - **Visual Notification:** Dot oranye berdenyut jika versi remote > versi lokal.
   - **Diagnostics:** Alt+click atau klik kanan pada tombol update untuk menjalankan audit sistem dan membuka file `feugee-update.log`.

---

## 2. Langkah Menambahkan Plugin Baru

Ikuti 6 langkah ini agar plugin baru otomatis memiliki seluruh fitur di atas:

### Langkah 1: Buat Folder Plugin
Salin salah satu plugin sebagai template (misal `Feugee_KnowledgeNuke_CEP/`) menjadi:
`Feugee_<Nama>_CEP/`

### Langkah 2: Sesuaikan `CSXS/manifest.xml`
Ubah 4 nilai berikut:
```xml
<ExtensionPackage>
  <ExtensionList>
    <Extension Id="com.feugee.<slug>.panel" Version="1.0.0"/>
  </ExtensionList>
  <ExtensionBundleId="com.feugee.<slug>" ExtensionBundleVersion="1.0.0" ...>
    <Extension Id="com.feugee.<slug>.panel">
      <DispatchInfo>
        <UI>
          <Menu>Feugee <Display Name></Menu>
        </UI>
      </DispatchInfo>
    </Extension>
  </ExtensionBundleId>
</ExtensionPackage>
```

### Langkah 3: Susun UI (`index.html`) & Host Logic (`jsx/host.jsx`)
- Tulis kartu & tombol di `index.html` (gunakan Bahasa Inggris untuk UI).
- Pastikan memuat:
  ```html
  <link rel="stylesheet" href="css/panel.css">
  ...
  <script src="js/panel.js"></script>
  <script src="js/modes.js"></script>
  ```
- Di `jsx/host.jsx`, bungkus seluruh logika dalam namespace IIFE:
  ```javascript
  var FG_<NAMA> = (function () {
    "use strict";
    ...
  })();
  ```

### Langkah 4: Daftarkan di `tools/build.py`
Tambahkan entri plugin di file `tools/build.py` pada array `PLUGINS`:
```python
PLUGINS = [
    ("Feugee_KnowledgeNuke_CEP", "knowledgenuke", "Knowledge Nuke", "Feugee_KnowledgeNuke"),
    ("Feugee_SideQuest_CEP", "sidequest", "SideQuest", "Feugee_SideQuest"),
    ("Feugelign_CEP", "feugelign", "Feugelign", "Feugelign"),
    ("Feugee_Motion_CEP", "feugeemotion", "Feugee Motion", "Feugee_Motion"),
    ("Feugee_<Nama>_CEP", "<slug>", "<Display Name>", "Feugee_<Prefix>"),
]
```

### Langkah 5: Sinkronisasi & Generate Bundle
Jalankan script build:
```bash
python3 tools/build.py --sync-modes --set <slug>=1.0.0
```
Script ini akan:
1. Menyalin `modes.js` dan `panel.css` canonical ke plugin baru.
2. Memperbarui versi di `manifest.xml` dan badge `index.html`.
3. Mengemas semua file teks ke `bundles/<slug>.json`.
4. Mendaftarkan entri di `updates.json` dan tabel `README.md`.

### Langkah 6: Jalankan Verifikasi & Push
```bash
# Jalankan test suite
node tools/tests/test-updater.js && node tools/tests/test-extendscript-path.js

# Commit & push ke GitHub
git add -A
git commit -m "feat: add new plugin Feugee <Nama>"
git push origin main

# Purge cache CDN jsDelivr
curl -s "https://purge.jsdelivr.net/gh/royalecreativelab/feugee-plugins@main/updates.json"
```

Begitu ter-push ke GitHub, pengguna After Effects yang sudah memasang plugin suite Feugee akan langsung dapat mengupdate dan menggunakan plugin baru tersebut secara instan.
