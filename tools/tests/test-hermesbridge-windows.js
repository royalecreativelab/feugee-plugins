// Unit test js/setup.js under a faked win32 environment (run on macOS).
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const SRC = process.argv[2] || path.join(__dirname, "..", "..", "Feugee_HermesBridge_CEP", "js", "setup.js");

// fake Windows user tree on disk (posix paths, but we check string building)
const T = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "hbwin-"));
Object.defineProperty(process, "platform", { value: "win32" });
const LA = "C:\\Users\\Budi Santoso\\AppData\\Local";
const AD = "C:\\Users\\Budi Santoso\\AppData\\Roaming";
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, {
  LOCALAPPDATA: LA, APPDATA: AD, Path: "C:\\Windows\\system32;C:\\Tools", PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\system32\\cmd.exe", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\Budi Santoso",
  HERMES_HOME: "C:\\should\\be\\dropped", PYTHONPATH: "x"
});
os.homedir = () => "C:\\Users\\Budi Santoso";

// fs stubs: pretend %LOCALAPPDATA%\hermes\bin\hermes.cmd exists
const realStat = fs.statSync;
let present = new Set([LA + "\\hermes\\bin\\hermes.cmd"]);
fs.statSync = (p) => { if (present.has(p)) return { isFile: () => true, size: 1 }; const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; };
fs.lstatSync = fs.statSync;

global.window = undefined;
require(SRC);
const S = global.HBSetup;

assert.strictEqual(S.IS_WIN, true);
assert.strictEqual(S.MOD, "Ctrl");
assert.strictEqual(S.HERMES_ROOT, LA + "\\hermes");
assert.strictEqual(S.profileDir(), LA + "\\hermes\\profiles\\aebridge");
assert.strictEqual(S.BASE, AD + "\\HermesBridge");
assert.strictEqual(S.WORK_CWD, AD + "\\HermesBridge\\workspace");
assert.ok(/install\.ps1/.test(S.INSTALL_CMD) && /-NonInteractive/.test(S.INSTALL_CMD));

// CLI discovery
assert.strictEqual(S.findHermes(), LA + "\\hermes\\bin\\hermes.cmd");
present = new Set([LA + "\\hermes\\bin\\hermes.exe", LA + "\\hermes\\bin\\hermes.cmd"]);
assert.strictEqual(S.findHermes(), LA + "\\hermes\\bin\\hermes.exe", ".exe preferred");
present = new Set(["C:\\Tools\\hermes.exe"]);
assert.strictEqual(S.findHermes(), "C:\\Tools\\hermes.exe", "found on PATH");
present = new Set([LA + "\\Microsoft\\WindowsApps\\hermes.exe"]);
assert.strictEqual(S.findHermes(), LA + "\\Microsoft\\WindowsApps\\hermes.exe", "MSIX alias");
present = new Set();
assert.strictEqual(S.findHermes(), null);

// spawning: .exe direct, .cmd via cmd.exe /s /c with quoting (space in path)
let c = S.commandFor(LA + "\\hermes\\bin\\hermes.exe", ["acp"]);
assert.deepStrictEqual(c, [LA + "\\hermes\\bin\\hermes.exe", ["acp"], {}]);
c = S.commandFor(LA + "\\hermes\\bin\\hermes.cmd", ["-p", "aebridge", "config", "set", "platform_toolsets.acp", "[vision,no_mcp]"]);
assert.strictEqual(c[0], "C:\\Windows\\system32\\cmd.exe");
assert.deepStrictEqual(c[1].slice(0, 3), ["/d", "/s", "/c"]);
assert.strictEqual(c[1][3], '""C:\\Users\\Budi Santoso\\AppData\\Local\\hermes\\bin\\hermes.cmd" -p aebridge config set platform_toolsets.acp "[vision,no_mcp]""');
assert.strictEqual(c[2].windowsVerbatimArguments, true);
c = S.commandFor(LA + "\\hermes\\bin\\hermes.cmd", ["profile", "create", "aebridge", "--description", "Hermes Bridge panel inside After Effects (ACP)"]);
assert.ok(c[1][3].includes('"Hermes Bridge panel inside After Effects (ACP)"'));

// env for the agent
const e = S.agentEnv(["C:\\x\\bin"]);
assert.strictEqual(e.HERMES_HOME, LA + "\\hermes\\profiles\\aebridge");
assert.ok(e.Path.startsWith("C:\\x\\bin;C:\\Windows\\system32"), e.Path);
assert.ok(!("PATH" in e) && !("PYTHONPATH" in e));
assert.strictEqual(e.SystemRoot, "C:\\Windows");
assert.strictEqual(e.PYTHONUTF8, "1");

// file urls
assert.strictEqual(S.fileUrl("C:\\Users\\Budi Santoso\\a#1.png"), "file:///C:/Users/Budi%20Santoso/a%231.png");
assert.strictEqual(S.urlToPath("file:///C:/Users/Budi%20Santoso/a.png"), "C:\\Users\\Budi Santoso\\a.png");
assert.strictEqual(S.urlToPath("C:\\plain\\x.png"), "C:\\plain\\x.png");
assert.strictEqual(S.urlToPath("file:///C:/Users/Budi%20Santoso/AppData/Roaming/Adobe/CEP/extensions/com.feugee.hermesbridge/index.html").replace(/[\\\/]index\.html$/i, ""),
  "C:\\Users\\Budi Santoso\\AppData\\Roaming\\Adobe\\CEP\\extensions\\com.feugee.hermesbridge");

// check(): no CLI -> install step, message says PC
S.check("C:\\ext").then((r) => {
  assert.strictEqual(r.step, "install");
  assert.ok(/PC/.test(r.message));
  console.log("ALL WINDOWS SETUP TESTS PASSED");
}).catch((err) => { console.error(err); process.exit(1); });
