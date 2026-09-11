#!/usr/bin/env python3
"""Build the update manifest and the live-update bundles.

  python3 tools/build.py --sync-modes            copy modes.js to every plugin
  python3 tools/build.py --set feugelign=1.3.0   bump a version (manifest + brand)
  python3 tools/build.py                         regenerate bundles + updates.json + README

Bundle files are what the panel installs in place, so anything listed in
BUNDLE_GLOBS has to be plain UTF-8 text.
"""

import argparse
import datetime
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "royalecreativelab/feugee-plugins"
RAW = "https://raw.githubusercontent.com/%s/main/" % REPO

# dir, slug, display name, release file prefix
PLUGINS = [
    ("Feugee_KnowledgeNuke_CEP", "knowledgenuke", "Knowledge Nuke", "Feugee_KnowledgeNuke"),
    ("Feugee_SideQuest_CEP", "sidequest", "SideQuest", "Feugee_SideQuest"),
    ("Feugelign_CEP", "feugelign", "Feugelign", "Feugelign"),
    ("Feugee_Motion_CEP", "feugeemotion", "Feugee Motion", "Feugee_Motion"),
]

SKIP_NAMES = {".DS_Store", ".debug", "feugee-update.log", ".feugee-write-test",
              "Thumbs.db", "feugee-update-config.json"}
SKIP_EXT = {".zxp", ".p12", ".png", ".jpg", ".jpeg", ".gif", ".zip", ".aep", ".ffx"}
CANONICAL_MODES = os.path.join(ROOT, "Feugelign_CEP", "js", "modes.js")
CANONICAL_PANEL_CSS = os.path.join(ROOT, "Feugelign_CEP", "css", "panel.css")



def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def write(path, text):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def manifest_path(pdir):
    return os.path.join(ROOT, pdir, "CSXS", "manifest.xml")


def plugin_meta(pdir):
    xml = read(manifest_path(pdir))
    return {
        "bundleId": re.search(r'ExtensionBundleId="([^"]+)"', xml).group(1),
        "version": re.search(r'ExtensionBundleVersion="([^"]+)"', xml).group(1),
    }


def bundle_files(pdir):
    """Every text file under the plugin folder, keyed by relative path."""
    base = os.path.join(ROOT, pdir)
    out = {}
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name in SKIP_NAMES or name.startswith("."):
                continue
            if os.path.splitext(name)[1].lower() in SKIP_EXT:
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            try:
                text = read(full)
            except UnicodeDecodeError:
                sys.exit("%s/%s is not UTF-8 text - the live updater can only "
                         "ship text files, add it to SKIP_EXT" % (pdir, rel))
            if "\x00" in text:
                sys.exit("%s/%s looks binary - add it to SKIP_EXT" % (pdir, rel))
            out[rel] = text
    return out


def set_version(pdir, version):
    mp = manifest_path(pdir)
    xml = read(mp)
    xml = re.sub(r'ExtensionBundleVersion="[^"]+"', 'ExtensionBundleVersion="%s"' % version, xml)
    xml = re.sub(r'(<Extension Id="[^"]+" Version=")[^"]+(")', r"\g<1>%s\g<2>" % version, xml)
    write(mp, xml)

    ip = os.path.join(ROOT, pdir, "index.html")
    html = read(ip)
    new_html, n = re.subn(r"(<p>[^<]*<b>v)[0-9][^<]*(</b></p>)", r"\g<1>%s\g<2>" % version, html, count=1)
    if not n:
        sys.exit("could not patch the version badge in %s/index.html" % pdir)
    write(ip, new_html)


def sync_modes():
    canon_modes = read(CANONICAL_MODES)
    canon_css = read(CANONICAL_PANEL_CSS)
    for pdir, _, _, _ in PLUGINS:
        target_modes = os.path.join(ROOT, pdir, "js", "modes.js")
        if read(target_modes) != canon_modes:
            write(target_modes, canon_modes)
            print("synced modes.js -> %s" % pdir)
        target_css = os.path.join(ROOT, pdir, "css", "panel.css")
        if read(target_css) != canon_css:
            write(target_css, canon_css)
            print("synced panel.css -> %s" % pdir)


def latest_zxp(prefix, version):
    """Only advertise a ZXP that actually exists for this exact version."""
    p = os.path.join(ROOT, "releases", "%s_v%s.zxp" % (prefix, version))
    return RAW + "releases/%s_v%s.zxp" % (prefix, version) if os.path.isfile(p) else None


def build():
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {"version": "1.0", "updatedAt": now, "plugins": {}}
    rows = []

    for pdir, slug, name, prefix in PLUGINS:
        meta = plugin_meta(pdir)
        files = bundle_files(pdir)
        brand = read(os.path.join(ROOT, pdir, "index.html"))
        badge = re.search(r"<b>v([0-9][^<]*)</b>", brand)
        if badge and badge.group(1) != meta["version"]:
            sys.exit("%s: manifest says v%s but index.html shows v%s - run --set %s=%s"
                     % (pdir, meta["version"], badge.group(1), slug, meta["version"]))

        bundle = {
            "slug": slug,
            "name": name,
            "bundleId": meta["bundleId"],
            "version": meta["version"],
            "updatedAt": now,
            "fileCount": len(files),
            "files": files,
        }
        bpath = os.path.join(ROOT, "bundles", "%s.json" % slug)
        write(bpath, json.dumps(bundle, ensure_ascii=False, indent=1))

        entry = {
            "slug": slug,
            "name": name,
            "version": meta["version"],
            "updatedAt": now,
            "force": True,
            "changelog": "v%s" % meta["version"],
            "bundleUrl": RAW + "bundles/%s.json" % slug,
            "installerUrl": RAW + "install/Install-Feugee-Plugins.command",
            "installerUrlWin": RAW + "install/Install-Feugee-Plugins.bat",
            # panels shipped before v2 open this when an update fails
            "releaseUrl": "https://github.com/%s#repair--reinstall" % REPO,
        }
        zxp = latest_zxp(prefix, meta["version"])
        if zxp:
            entry["zxpUrl"] = zxp
        manifest["plugins"][slug] = entry

        dl = "[ZXP](releases/%s_v%s.zxp)" % (prefix, meta["version"]) if zxp else "installer script"
        rows.append("| **%s** | `v%s` | %d files | %s |" % (name, meta["version"], len(files), dl))
        print("bundle %-14s v%-7s %2d files  %6.1f KB" %
              (slug, meta["version"], len(files), os.path.getsize(bpath) / 1024.0))

    write(os.path.join(ROOT, "updates.json"), json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    readme = read(os.path.join(ROOT, "README.md"))
    table = "\n".join(["| Plugin | Version | Payload | Download |", "|---|---|---|---|"] + rows)
    readme = re.sub(r"<!-- TABLE -->.*?<!-- /TABLE -->",
                    "<!-- TABLE -->\n%s\n<!-- /TABLE -->" % table, readme, flags=re.S)
    write(os.path.join(ROOT, "README.md"), readme)
    print("updates.json + README updated")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sync-modes", action="store_true")
    ap.add_argument("--set", action="append", default=[], metavar="slug=version")
    args = ap.parse_args()

    by_slug = {slug: pdir for pdir, slug, _, _ in PLUGINS}
    for pair in args.set:
        slug, _, version = pair.partition("=")
        if slug not in by_slug:
            sys.exit("unknown plugin %r" % slug)
        set_version(by_slug[slug], version)
        print("set %s -> v%s" % (slug, version))

    if args.sync_modes:
        sync_modes()

    build()


if __name__ == "__main__":
    main()
