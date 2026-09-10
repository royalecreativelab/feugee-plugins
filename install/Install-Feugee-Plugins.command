#!/bin/bash
# Feugee Studio - installer & repair (macOS)
# Installs every Feugee panel straight from GitHub into the per-user CEP
# folder, which - unlike the system-wide one a ZXP installer uses - After
# Effects can actually write to. That is what makes live updates work.
# Double-click this file. No admin password needed.

set -u
cd "$(dirname "$0")" || exit 1

echo ""
echo "  FEUGEE STUDIO - plugin installer"
echo "  --------------------------------"
echo ""

if pgrep -x "After Effects" >/dev/null 2>&1; then
  echo "  ! After Effects is running. Quit it first, then run this again."
  echo ""
  read -r -p "  Press return to close..." _
  exit 1
fi

/usr/bin/osascript -l JavaScript <<'JXA'
ObjC.import('Foundation');

var RAW = 'https://raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/';
var PLUGINS = [
  { slug: 'knowledgenuke', id: 'com.feugee.knowledgenuke', name: 'Knowledge Nuke' },
  { slug: 'sidequest',     id: 'com.feugee.sidequest',     name: 'SideQuest' },
  { slug: 'feugelign',     id: 'com.feugee.feugelign',     name: 'Feugelign' },
  { slug: 'feugeemotion',  id: 'com.feugee.motion',        name: 'Feugee Motion' }
];

var app = Application.currentApplication();
app.includeStandardAdditions = true;

var fm = $.NSFileManager.defaultManager;
var HOME = ObjC.unwrap($.NSHomeDirectory());
var USER_EXT = HOME + '/Library/Application Support/Adobe/CEP/extensions';
var SYS_EXT = '/Library/Application Support/Adobe/CEP/extensions';

function say(s) { console.log(s); }

function mkdirp(p) {
  fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(p, true, $(), null);
}

function readText(p) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  return s.isNil() ? null : ObjC.unwrap(s);
}

function writeText(p, text) {
  mkdirp(p.substring(0, p.lastIndexOf('/')));
  var s = $.NSString.alloc.initWithUTF8String(text);
  return s.writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null);
}

function download(url, dest) {
  try {
    app.doShellScript("curl -fsSL --retry 2 --max-time 90 " + JSON.stringify(url) + " -o " + JSON.stringify(dest));
    return true;
  } catch (e) {
    say('    download failed: ' + e.message);
    return false;
  }
}

function debugPort(bundleId) {
  var h = 0;
  for (var i = 0; i < bundleId.length; i++) h = (h * 31 + bundleId.charCodeAt(i)) % 900;
  return 8100 + h;
}

function debugXml(id, port) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<ExtensionList>\n  <Extension Id="' + id +
    '.panel">\n    <HostList>\n      <Host Name="AEFT" Port="' + port +
    '"/>\n    </HostList>\n  </Extension>\n</ExtensionList>\n';
}

var tmp = ObjC.unwrap($.NSTemporaryDirectory()) + 'feugee-install';
mkdirp(tmp);

say('  target: ' + USER_EXT);
say('');

var installed = 0;
var failed = [];
var shadowed = [];

PLUGINS.forEach(function (p) {
  say('  ' + p.name);
  var jsonPath = tmp + '/' + p.slug + '.json';
  if (!download(RAW + 'bundles/' + p.slug + '.json?_t=' + Date.now(), jsonPath)) {
    failed.push(p.name + ' (download)');
    return;
  }

  var bundle;
  try {
    bundle = JSON.parse(readText(jsonPath));
  } catch (e) {
    say('    bad bundle json');
    failed.push(p.name + ' (bad json)');
    return;
  }
  if (!bundle || !bundle.files) {
    failed.push(p.name + ' (empty bundle)');
    return;
  }

  var dest = USER_EXT + '/' + p.id;
  mkdirp(dest);

  var ok = true;
  Object.keys(bundle.files).forEach(function (rel) {
    if (!writeText(dest + '/' + rel, bundle.files[rel])) {
      say('    could not write ' + rel);
      ok = false;
    }
  });

  if (!ok) {
    failed.push(p.name + ' (write)');
    return;
  }

  writeText(dest + '/.debug', debugXml(p.id, debugPort(p.id)));

  if (fm.fileExistsAtPath(SYS_EXT + '/' + p.id)) shadowed.push(SYS_EXT + '/' + p.id);

  say('    installed v' + bundle.version + ' (' + Object.keys(bundle.files).length + ' files)');
  installed++;
});

say('');
say('  enabling live-update mode (CEP PlayerDebugMode)...');
try {
  app.doShellScript('for i in $(seq 9 26); do defaults write com.adobe.CSXS.$i PlayerDebugMode 1; done');
  say('    done');
} catch (e) {
  say('    failed: ' + e.message);
}

say('');
say('  ' + installed + '/' + PLUGINS.length + ' plugins installed');
if (failed.length) say('  failed: ' + failed.join(', '));

if (shadowed.length) {
  say('');
  say('  ! An older system-wide copy still exists and will clash:');
  shadowed.forEach(function (s) { say('      ' + s); });
  say('    Remove it once, in Terminal:');
  say('      sudo rm -rf ' + shadowed.map(function (s) { return JSON.stringify(s); }).join(' '));
}
JXA

echo ""
echo "  Open After Effects -> Window > Extensions."
echo "  From now on the update button installs new versions in place."
echo ""
read -r -p "  Press return to close..." _
