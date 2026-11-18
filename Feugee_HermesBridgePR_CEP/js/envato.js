/* =========================================================
   HERMES BRIDGE - ENVATO ELEMENTS
   Shared by the After Effects panel, the Premiere Pro panel and
   bin/hb-mcp-proxy.js (byte-identical in both extensions).

   1. envato_search: the official Envato MCP (https://mcp.envato.com/mcp,
      public, search only) behind ONE compact tool instead of its 15
      schemas (~8k tokens). Results are trimmed to what an editor needs
      and cover images are cached locally so the agent can vision_analyze
      them and the panel can show them as cards.
   2. import_media: Envato has no download API, so with download:true the
      item is downloaded in the user's own logged-in browser over CDP
      (background tab; Envato records the licence in the user's workspace),
      else the user clicks DOWNLOAD. Then: wait for the finished file in Downloads,
      unzip, copy next to the project, classify (media / AE template /
      MOGRT / font / LUT / help docs), detect image sequences, then the
      host imports it into an "Envato" folder/bin.
   Node only (CEP mixed context or plain node). No ExtendScript here.
   ========================================================= */
(function (global) {
  "use strict";

  var fs = require("fs");
  var os = require("os");
  var cp = require("child_process");
  var https = require("https");
  var Buffer = require("buffer").Buffer;   // CEP window context may not expose the Buffer global
  var WIN = process.platform === "win32";
  var path = WIN ? require("path").win32 : require("path").posix;

  var MCP_URL = "https://mcp.envato.com/mcp";
  var ITEM_TYPES = ["stock-video", "music", "sound-effects", "video-templates", "photos", "graphics",
    "graphic-templates", "fonts", "3d", "add-ons", "presentation-templates", "web-templates", "wordpress", "cms-templates"];

  // ---------------------------------------------------------
  // TOOL SCHEMAS (appended to the panel's own MCP tool list)
  // ---------------------------------------------------------
  function toolsFor(app) {
    var ae = app !== "ppro";
    var host = ae ? "After Effects" : "Premiere Pro";
    var where = ae ? "a project folder" : "a bin";
    return [
      {
        name: "envato_search",
        description: "Search the Envato Elements catalog (stock video, music, SFX, " + (ae ? "After Effects" : "Premiere Pro") + " templates, photos, graphics, fonts, 3D). " +
          "Returns per item: title, author, item id, item_url (the page where the user downloads it) and a cached local cover JPEG (preview) you can vision_analyze. " +
          "The panel shows the results to the user as clickable cards. To get an item the user picked: import_media {item_url, download: true} downloads it in the user's own logged-in browser and imports it. " +
          "Useful filters (exact values): stock-video {orientation: horizontal|vertical, resolution: '1080p (Full HD)'|'4K (UHD)', categories: 'Stock Footage'|'Motion Graphics', has_alpha_channel, is_looped, frame_rate: '25 fps'...}; " +
          "music {mood: happy|sad|inspiring|dramatic|dark|upbeat|chill|funny|angry|relaxing|romantic|epic, tempo: 'Slow (60-90 BPM)'|'Medium (90-110 BPM)'|'Upbeat (110-140 BPM)'|'Fast (140-160 BPM)', genre: cinematic|corporate|electronic|hip hop|ambient|pop|rock..., vocals_in_audio: 'No Vocals', claim_clear: true, has_music_stems: true, categories: 'Music Tracks'|'Logos & Idents'}; " +
          "sound-effects {categories: 'Transitions & Movement'|'Interface Sounds'|'Futuristic Sounds'|'Human Sounds'|'Nature Sounds'|'Urban Sounds'|'Cartoon Sounds'...}; " +
          "video-templates {applications_supported: '" + host + "', categories: Titles|Openers|'Logo Stings'|Elements|Infographics|'Product Promo'|'Broadcast Packages'|LUTs|'Video Displays', resolution} (required_plugins is broken upstream and ignored); " +
          "photos {orientation: landscape|portrait|square, colors, number_of_people}; graphics {categories: Backgrounds|Textures|Patterns|Icons|Objects|Illustrations, is_vector, is_animated}; " +
          "fonts {categories: serif|sans_serif|script|decorative_display|monospace|handwritten_brush}. A wrong filter value returns the list of valid ones.",
        inputSchema: { type: "object", required: ["item_type", "query"], properties: {
          item_type: { type: "string", enum: ITEM_TYPES },
          query: { type: "string", description: "Short English keywords, max 60 chars (Envato search is keyword based: 'neon city night', not a sentence)." },
          filters: { type: "object", description: "Typed filters for that item type, see the tool description. Omit for none." },
          sort: { type: "string", enum: ["relevance", "popular", "latest"], description: "Default relevance." },
          per_page: { type: "integer", description: "1-20, default 8." },
          page: { type: "integer", description: "Default 1." },
          previews: { type: "boolean", description: "Cache cover images locally for vision_analyze (default true)." }
        } }
      },
      {
        name: "import_media",
        description: "Import downloaded media into the open " + host + " project, built for Envato Elements downloads. " +
          "Finds the finished download in ~/Downloads (or takes explicit paths), unzips archives, copies everything into '<project folder>/Envato Assets/' so the project never points at Downloads, " +
          "skips macOS junk, detects image sequences, then imports into " + where + " 'Envato/<pack>'. Already-imported files are reused, not duplicated. " +
          (ae ? "An archive that contains an .aep template imports only the newest .aep (its footage stays linked) and lists the help docs and fonts. "
              : "MOGRT files are returned in `mogrt` (place them with seq.importMGT(path, ticks, vTrackIndex, aTrackIndex) in run_script); .aep/.prproj templates are listed, not imported. ") +
          "Fonts and LUTs are listed (install_fonts=true copies fonts to the user font folder). " +
          "Typical flow: envato_search -> user picks an item -> import_media {item_url, title, download: true}: the bridge licenses the item to this project on the user's Envato account (logged-in session saved in the bridge) and downloads it directly, no browser click, then unzips and imports. " +
          "Needs a one-time envato_account {action: 'login'}; a needLogin result means call that. Large files (4K, big template packs) may outlast the call: the result then says in_progress with percent; call import_media again with the same item_url to pick it up (never re-licenses). " +
          "User already downloaded it himself: import_media {item_url, wait_seconds: 120} without download. " +
          "Returns imported items with their project ids/names" + (ae ? "" : " and bin") + ".",
        inputSchema: { type: "object", properties: {
          item_url: { type: "string", description: "Envato item_url from envato_search: matches the download by item id/slug and writes ENVATO-SOURCE.txt (licence trail) next to the files." },
          download: { type: "boolean", description: "true = the bridge licenses + downloads item_url itself (native, user's Envato session), then imports. Only for items the user chose; never to browse or bulk-download." },
          project_name: { type: "string", description: "With download: Envato licence project name (default: the open project's file name)." },
          resolution: { type: "string", description: "With download: stock-video variant, '1080' (default, small) or '4K' (comp >= 3840 wide or the user asks; hundreds of MB). Ignored for items without variants." },
          paths: { type: "array", items: { type: "string" }, description: "Explicit files, folders or .zip archives. Omit to use ~/Downloads." },
          match: { type: "string", description: "Case-insensitive filename filter for ~/Downloads." },
          from_downloads_minutes: { type: "integer", description: "How far back to look in ~/Downloads (default 30)." },
          wait_seconds: { type: "integer", description: "If nothing finished downloading yet, wait up to this long for a new download (max 150, default 0)." },
          bin: { type: "string", description: (ae ? "Project folder" : "Bin") + " to import into, '/' separated (default 'Envato/<pack name>')." },
          dest_dir: { type: "string", description: "Where files are copied/extracted (default '<project folder>/Envato Assets')." },
          copy: { type: "boolean", description: "Copy loose files out of Downloads (default true)." },
          install_fonts: { type: "boolean", description: "Copy .otf/.ttf found in the pack to the user font folder (default false)." },
          title: { type: "string", description: "Item title for ENVATO-SOURCE.txt." }
        } }
      },
      {
        name: "envato_account",
        description: "The Envato Elements session the bridge downloads with. status: signed in or not. login: first re-logs in headless (silent SSO, else the Feugee account password from the macOS Keychain service FeugeeEnvato); only if that fails (captcha, 2FA, no Keychain entry) it opens a plain Envato sign-in window, the user signs in and closes it (Cmd+Q), the call waits up to 4 min and saves the session. status also auto re-logs in when the session dropped. import_media re-logs in by itself too. logout: forget the session. Only call login when import_media said needLogin or the user asks.",
        inputSchema: { type: "object", required: ["action"], properties: {
          action: { type: "string", enum: ["status", "login", "logout"] }
        } }
      }
    ];
  }

  // ---------------------------------------------------------
  // ENVATO MCP CLIENT (stateless streamable HTTP, SSE or JSON reply)
  // ---------------------------------------------------------
  var reqId = 0;

  function postJson(url, body, headers, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var u = new URL(url), data = Buffer.from(JSON.stringify(body), "utf8"), done = false;
      var h = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18", "Content-Length": data.length, "User-Agent": "HermesBridge/2.5 (Feugee)" };
      for (var k in headers || {}) h[k] = headers[k];
      var req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST", headers: h }, function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          if (done) return; done = true;
          resolve({ status: res.statusCode, type: String(res.headers["content-type"] || ""), session: res.headers["mcp-session-id"], text: Buffer.concat(chunks).toString("utf8") });
        });
      });
      req.setTimeout(timeoutMs || 25000, function () { if (done) return; done = true; req.destroy(); reject(new Error("Envato tidak menjawab dalam " + ((timeoutMs || 25000) / 1000) + " dtk")); });
      req.on("error", function (e) { if (done) return; done = true; reject(e); });
      req.end(data);
    });
  }

  // Pull the JSON-RPC message with our id out of an SSE or JSON body.
  function rpcReply(r, id) {
    var msgs = [];
    if (/event-stream/.test(r.type)) {
      r.text.split(/\r?\n\r?\n/).forEach(function (evt) {
        var data = evt.split(/\r?\n/).filter(function (l) { return l.indexOf("data:") === 0; })
          .map(function (l) { return l.slice(5).replace(/^ /, ""); }).join("\n");
        if (data) { try { msgs.push(JSON.parse(data)); } catch (e) {} }
      });
    } else {
      try { var j = JSON.parse(r.text); msgs = Array.isArray(j) ? j : [j]; } catch (e) {}
    }
    for (var i = 0; i < msgs.length; i++) if (msgs[i] && msgs[i].id === id) return msgs[i];
    return null;
  }

  var session = null;
  function rpc(method, params, timeoutMs) {
    var id = ++reqId;
    function once() {
      var hdr = session ? { "Mcp-Session-Id": session } : {};
      return postJson(MCP_URL, { jsonrpc: "2.0", id: id, method: method, params: params || {} }, hdr, timeoutMs).then(function (r) {
        if (r.session) session = r.session;
        if (r.status === 404 && session) { session = null; throw { retry: true }; }
        if (r.status >= 400) throw new Error("Envato HTTP " + r.status + ": " + r.text.slice(0, 200));
        var m = rpcReply(r, id);
        if (!m) throw new Error("balasan Envato tidak terbaca: " + r.text.slice(0, 200));
        if (m.error) throw new Error("Envato: " + (m.error.message || JSON.stringify(m.error)));
        return m.result;
      });
    }
    return once().catch(function (e) { if (e && e.retry) return once(); throw e; });
  }

  // ---------------------------------------------------------
  // SEARCH
  // ---------------------------------------------------------
  function itemId(url) {
    var m = String(url || "").match(/-([A-Z0-9]{5,10})\/?(?:[?#].*)?$/);
    return m ? m[1] : null;
  }
  function slugOf(url) {
    var s = String(url || "").replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() || "";
    return s.replace(/-[A-Z0-9]{5,10}$/, "");
  }

  function cleanFilters(f) {
    if (!f || typeof f !== "object") return null;
    var out = {}, n = 0;
    for (var k in f) {
      if (!Object.prototype.hasOwnProperty.call(f, k)) continue;
      var v = f[k];
      if (v === null || v === undefined || v === "") continue;
      out[k] = v; n++;
    }
    return n ? out : null;
  }

  function fetchFile(url, dst, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      function fin(ok) { if (done) return; done = true; resolve(ok ? dst : null); }
      try {
        var req = https.get(url, { headers: { "User-Agent": "HermesBridge/2.5 (Feugee)" } }, function (res) {
          if (res.statusCode !== 200) { res.resume(); return fin(false); }
          var tmp = dst + ".part", out = fs.createWriteStream(tmp);
          res.pipe(out);
          out.on("finish", function () { out.close(function () { try { fs.renameSync(tmp, dst); fin(true); } catch (e) { fin(false); } }); });
          out.on("error", function () { fin(false); });
        });
        req.setTimeout(timeoutMs || 10000, function () { req.destroy(); fin(false); });
        req.on("error", function () { fin(false); });
      } catch (e) { fin(false); }
    });
  }

  // Cover thumbnails: kept 3 days, then swept.
  function sweep(dir, hours) {
    try {
      var now = Date.now();
      fs.readdirSync(dir).forEach(function (f) {
        var p = path.join(dir, f);
        try { if (now - fs.statSync(p).mtimeMs > hours * 3600000) fs.unlinkSync(p); } catch (e) {}
      });
    } catch (e) {}
  }

  function search(a, opts) {
    a = a || {}; opts = opts || {};
    var type = String(a.item_type || "").trim().toLowerCase().replace(/[ _]+/g, "-");
    if (type === "video" || type === "stock-footage" || type === "footage") type = "stock-video";
    if (type === "sfx" || type === "sound-effect") type = "sound-effects";
    if (type === "templates" || type === "video-template") type = "video-templates";
    if (ITEM_TYPES.indexOf(type) < 0) return Promise.resolve({ ok: false, error: "item_type harus salah satu: " + ITEM_TYPES.join(", ") });
    var q = String(a.query || a.searchTerms || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!q) return Promise.resolve({ ok: false, error: "query wajib diisi (keyword bahasa Inggris)" });
    var per = Math.max(1, Math.min(20, parseInt(a.per_page, 10) || 8));
    var args = { searchTerms: q, perPage: per, page: Math.max(1, parseInt(a.page, 10) || 1), sortBy: a.sort || "relevance" };
    var f = cleanFilters(a.filters), dropped = [];
    // Envato bug (checked 2026-11-05): required_plugins returns 0 items for
    // every query, so it would hide every template. Drop it and say so.
    if (f && f.required_plugins !== undefined) { dropped.push("required_plugins (rusak di Envato: selalu 0 hasil) - cek kebutuhan plugin di halaman item"); delete f.required_plugins; if (!Object.keys(f).length) f = null; }
    if (f) args.filters = f;
    var tool = "search_" + type.replace(/-/g, "_");
    var t0 = Date.now();
    return rpc("tools/call", { name: tool, arguments: args }, 30000).then(function (res) {
      var text = ((res && res.content) || []).filter(function (c) { return c.type === "text"; }).map(function (c) { return c.text; }).join("\n");
      if (res && res.isError) return { ok: false, error: "Envato menolak pencarian: " + text.slice(0, 1200) };
      var data = null;
      try { data = JSON.parse(text); } catch (e) {}
      if (!data && res && res.structuredContent && res.structuredContent.items) data = res.structuredContent;
      if (!data || !data.items) return { ok: false, error: "format hasil Envato berubah: " + text.slice(0, 400) };
      var pg = data.pagination || {};
      var items = data.items.map(function (it, i) {
        var o = { n: i + 1, title: it.title, author: it.author, id: itemId(it.item_url), url: it.item_url, cover: it.cover_image };
        if (it.aspect_ratio) o.aspect = Math.round(it.aspect_ratio * 1000) / 1000;
        // keep any extra fields Envato adds (duration, bpm, ...) but not bulky ones
        for (var k in it) {
          if (/^(title|author|item_url|cover_image|aspect_ratio|item_type)$/.test(k)) continue;
          var v = it[k];
          if (v !== null && v !== undefined && (typeof v !== "object" || JSON.stringify(v).length < 200)) o[k] = v;
        }
        return o;
      });
      var out = { ok: true, data: {
        item_type: type, query: q, filters: f || undefined, sort: args.sortBy,
        page: pg.current_page || args.page, returned: items.length, has_next: !!pg.has_next_page,
        applied_filters: data.applied_filters, items: items, ms: Date.now() - t0
      } };
      if (dropped.length) out.data.dropped_filters = dropped;
      if (!items.length) out.data.hint = "0 hasil: kurangi filter atau pakai keyword lebih umum (1-2 kata), jangan ulang query yang sama.";
      if (a.previews === false || !opts.previewDir || !items.length) return out;
      try { fs.mkdirSync(opts.previewDir, { recursive: true }); } catch (e) {}
      sweep(opts.previewDir, 72);
      return Promise.all(items.map(function (it, i) {
        if (!it.cover) return null;
        var name = (it.id || ("item" + i)) + "_" + String(it.cover).replace(/[^a-z0-9]/gi, "").slice(-10) + ".jpg";
        var dst = path.join(opts.previewDir, name);
        if (fs.existsSync(dst)) return dst;
        return fetchFile(it.cover, dst, 10000);
      })).then(function (paths) {
        paths.forEach(function (p, i) { if (p) items[i].preview = p; });
        out.data.hint = "Tunjukkan pilihan terbaik ke user (judul + item_url). preview = JPEG lokal untuk vision_analyze. Setelah user memilih: import_media {item_url, title, download: true}.";
        return out;
      });
    }).catch(function (e) {
      return { ok: false, infra: true, error: "Envato MCP tidak bisa dijangkau: " + (e && e.message || e) };
    });
  }

  // ---------------------------------------------------------
  // FILES: find downloads, unzip, copy, classify
  // ---------------------------------------------------------
  var KIND = {
    video: /\.(mp4|mov|m4v|avi|mxf|mkv|webm|mpg|mpeg|wmv|flv|m2ts|mts|3gp|prores)$/i,
    audio: /\.(wav|mp3|aif|aiff|m4a|aac|ogg|flac|wma|bwf)$/i,
    image: /\.(png|jpe?g|tiff?|psd|ai|eps|svg|gif|bmp|tga|exr|hdr|webp|heic|dpx|pdf_img)$/i,
    aep: /\.(aep|aet)$/i,
    prproj: /\.prproj$/i,
    mogrt: /\.mogrt$/i,
    lut: /\.(cube|3dl|look|csp)$/i,
    font: /\.(otf|ttf|ttc)$/i,
    preset: /\.(ffx|prfpset|epr|aex|plugin)$/i,
    doc: /\.(pdf|txt|rtf|html?|md|url|webloc|docx?)$/i,
    model: /\.(obj|fbx|glb|gltf|blend|c4d|abc|usdz?)$/i,
    archive: /\.(zip)$/i,
    otherArchive: /\.(rar|7z|tar|gz)$/i
  };
  var PARTIAL = /\.(crdownload|download|part|partial|tmp|opdownload)$/i;
  var JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|\._.*|\.localized)$/i;

  function kindOf(p) {
    for (var k in KIND) if (KIND[k].test(p)) return k;
    return "other";
  }

  function downloadsDir() {
    if (WIN) {
      var up = process.env.USERPROFILE || os.homedir();
      return path.join(up, "Downloads");
    }
    return path.join(os.homedir(), "Downloads");
  }

  function stat(p) { try { return fs.statSync(p); } catch (e) { return null; } }

  // Words we can look for in a download's file name.
  function matchTokens(itemUrl, match) {
    var t = [];
    if (match) t.push(String(match).toLowerCase());
    var id = itemId(itemUrl);
    if (id) t.push(id.toLowerCase());
    var slug = slugOf(itemUrl).toLowerCase();
    if (slug && slug.length >= 6) {
      t.push(slug);
      t.push(slug.replace(/-/g, "_"));
      t.push(slug.replace(/-/g, " "));
      t.push(slug.slice(0, 24));
    }
    return t;
  }
  function nameHits(name, tokens) {
    var n = name.toLowerCase();
    for (var i = 0; i < tokens.length; i++) if (tokens[i] && n.indexOf(tokens[i]) >= 0) return true;
    return false;
  }

  // Finished downloads in dir newer than sinceMs. A file is finished when no
  // .crdownload/.download sibling exists and its size held for one check.
  function scanDownloads(dir, sinceMs) {
    var list = [];
    var names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return list; }
    var partial = {};
    names.forEach(function (n) { if (PARTIAL.test(n)) partial[n.replace(PARTIAL, "").toLowerCase()] = true; });
    names.forEach(function (n) {
      if (n.charAt(0) === "." || JUNK.test(n) || PARTIAL.test(n) || partial[n.toLowerCase()]) return;
      var p = path.join(dir, n), s = stat(p);
      if (!s) return;
      var t = Math.max(s.mtimeMs, s.birthtimeMs || 0, s.ctimeMs || 0);
      if (t < sinceMs) return;
      list.push({ path: p, name: n, size: s.isDirectory() ? -1 : s.size, dir: s.isDirectory(), t: t });
    });
    list.sort(function (a, b) { return b.t - a.t; });
    return list;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function stable(entry) {
    if (entry.dir) return Promise.resolve(true);
    return sleep(1200).then(function () {
      var s = stat(entry.path);
      return !!s && s.size === entry.size && s.size > 0;
    });
  }

  // Resolve which downloads to import. callStart: files that appeared after
  // the tool call began are the user's fresh click and are accepted even
  // when their name does not carry the Envato id.
  function findDownloads(o) {
    var dir = o.downloadsDir || downloadsDir();
    var since = Date.now() - Math.max(1, o.minutes || 30) * 60000;
    var callStart = Date.now();
    var tokens = matchTokens(o.itemUrl, o.match);
    var deadline = Date.now() + Math.min(150, Math.max(0, o.waitSeconds || 0)) * 1000;

    function pick() {
      var all = scanDownloads(dir, since);
      var hit = tokens.length ? all.filter(function (e) { return nameHits(e.name, tokens); }) : all.slice();
      if (!hit.length && tokens.length && o.waitSeconds) hit = all.filter(function (e) { return e.t >= callStart; });
      // without an explicit match take only the newest download (plus files
      // that landed within 90 s of it, e.g. a multi-file pack)
      if (!tokens.length && hit.length) {
        var top = hit[0].t;
        hit = hit.filter(function (e) { return top - e.t < 90000; });
      }
      return hit;
    }

    function loop() {
      var hit = pick();
      if (!hit.length) {
        if (Date.now() < deadline) return sleep(1000).then(loop);
        return Promise.resolve([]);
      }
      return Promise.all(hit.map(stable)).then(function (ok) {
        if (ok.every(Boolean)) return hit;
        if (Date.now() < deadline + 60000) return loop();   // still writing: give it a minute
        return hit.filter(function (e, i) { return ok[i]; });
      });
    }
    return loop();
  }

  function execP(file, args, timeoutMs) {
    return new Promise(function (resolve) {
      cp.execFile(file, args, { timeout: timeoutMs || 240000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, function (err, so, se) {
        resolve({ ok: !err, out: String(so || "") + String(se || ""), err: err });
      });
    });
  }

  function unzip(zip, dst) {
    try { fs.mkdirSync(dst, { recursive: true }); } catch (e) {}
    var tries = WIN
      ? [[path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", dst]],
         ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + dst.replace(/'/g, "''") + "' -Force"]]]
      : [["/usr/bin/ditto", ["-x", "-k", "--sequesterRsrc", zip, dst]], ["/usr/bin/unzip", ["-q", "-o", zip, "-d", dst]]];
    var i = 0;
    function next(last) {
      if (i >= tries.length) return Promise.resolve({ ok: false, error: "gagal unzip " + path.basename(zip) + ": " + String(last && last.out || "").slice(0, 300) });
      var t = tries[i++];
      if (!fs.existsSync(t[0]) && /[\\\/]/.test(t[0])) return next(last);
      return execP(t[0], t[1]).then(function (r) { return r.ok ? { ok: true } : next(r); });
    }
    return next(null);
  }

  function copyP(src, dst) {
    return new Promise(function (resolve) {
      var flag = fs.constants && fs.constants.COPYFILE_FICLONE ? fs.constants.COPYFILE_FICLONE : 0;
      fs.copyFile(src, dst, flag, function (e) { resolve(e ? { ok: false, error: e.message } : { ok: true }); });
    });
  }

  function copyTree(src, dst) {
    var jobs = [];
    (function walk(s, d) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
      fs.readdirSync(s).forEach(function (n) {
        if (JUNK.test(n)) return;
        var a = path.join(s, n), b = path.join(d, n), st = stat(a);
        if (!st) return;
        if (st.isDirectory()) walk(a, b);
        else if (!stat(b) || stat(b).size !== st.size) jobs.push([a, b]);
      });
    })(src, dst);
    return jobs.reduce(function (p, j) { return p.then(function () { return copyP(j[0], j[1]); }); }, Promise.resolve());
  }

  function walkFiles(root, out, depth) {
    out = out || []; depth = depth || 0;
    if (depth > 12) return out;
    var st = stat(root);
    if (!st) return out;
    if (!st.isDirectory()) { out.push(root); return out; }
    var names = [];
    try { names = fs.readdirSync(root); } catch (e) { return out; }
    names.sort().forEach(function (n) {
      if (JUNK.test(n) || n.charAt(0) === ".") return;
      walkFiles(path.join(root, n), out, depth + 1);
    });
    return out;
  }

  function safeName(s) {
    return String(s || "Envato").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\\\/:*?"<>|]+/g, " ")
      .replace(/^elements[-_ ]/i, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Envato";
  }

  // Image sequences: >= 8 numbered stills with one prefix in one folder.
  function groupSequences(files) {
    var groups = {}, singles = [];
    files.forEach(function (f) {
      var m = path.basename(f).match(/^(.*?)(\d{3,})\.(png|jpe?g|tiff?|exr|tga|dpx|bmp)$/i);
      if (!m) return singles.push(f);
      var key = path.dirname(f) + "|" + m[1] + "|" + m[3].toLowerCase() + "|" + m[2].length;
      (groups[key] = groups[key] || []).push(f);
    });
    var seqs = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k].sort();
      if (g.length >= 8) seqs.push({ path: g[0], frames: g.length });
      else singles.push.apply(singles, g);
    });
    return { seqs: seqs, singles: singles.sort() };
  }

  // Newest After Effects project in a pack: "CC2023" beats "CC2020" beats "CS6".
  function aepRank(p) {
    var s = p.toLowerCase(), m = s.match(/(?:cc\s*|20)(\d{2,4})/g), best = 0;
    (m || []).forEach(function (x) {
      var n = parseInt(x.replace(/\D/g, ""), 10);
      if (n < 100) n += 2000;
      if (n > best && n < 2100) best = n;
    });
    if (/cs\s*6/.test(s)) best = Math.max(best, 2012);
    if (/(^|[^a-z])(old|legacy)([^a-z]|$)/.test(s)) best -= 50;
    return best;
  }

  // Build the import plan for one pack (archive, folder or loose file).
  function planPack(root, label, app) {
    var files = walkFiles(root);
    var by = {};
    files.forEach(function (f) { var k = kindOf(f); (by[k] = by[k] || []).push(f); });
    var plan = { pack: label, root: root, files: files.length, import: [], templates: [], mogrt: by.mogrt || [],
      fonts: by.font || [], luts: by.lut || [], presets: by.preset || [], docs: (by.doc || []).filter(function (f) { return !/ENVATO-SOURCE\.txt$/i.test(f); }).slice(0, 8),
      models: by.model || [], skipped: [], notes: [] };
    var aeps = (by.aep || []).slice().sort(function (a, b) { return aepRank(b) - aepRank(a) || a.length - b.length; });
    if (app !== "ppro" && aeps.length) {
      plan.import.push({ path: aeps[0], kind: "aep" });
      plan.templates = aeps;
      plan.notes.push("Template AE: hanya " + path.basename(aeps[0]) + " yang diimport (versi terbaru). Footage di dalam pack tetap ter-link dari " + root + ".");
      if (aeps.length > 1) plan.notes.push("Versi lain dilewati: " + aeps.slice(1).map(function (p) { return path.basename(p); }).join(", "));
      return plan;
    }
    if (app === "ppro") {
      plan.templates = aeps.concat(by.prproj || []);
      if (plan.templates.length) plan.notes.push("Template .aep/.prproj tidak diimport otomatis: buka lewat File > Import kalau memang perlu (bisa memunculkan dialog).");
      if (plan.mogrt.length) plan.notes.push(plan.mogrt.length + " MOGRT siap ditaruh ke timeline lewat seq.importMGT(path, ticks, vTrack, aTrack).");
    } else if (by.prproj) plan.skipped = plan.skipped.concat(by.prproj);
    var media = (by.video || []).concat(by.audio || []).concat(by.image || []);
    var g = groupSequences(media);
    g.seqs.forEach(function (s) { plan.import.push({ path: s.path, kind: "sequence", frames: s.frames }); });
    g.singles.forEach(function (p) { plan.import.push({ path: p, kind: kindOf(p) }); });
    if (plan.import.length > 150) {
      plan.notes.push(plan.import.length + " file media; yang diimport 150 pertama, sisanya ada di " + root);
      plan.import = plan.import.slice(0, 150);
    }
    if (by.otherArchive) plan.notes.push("Arsip non-zip tidak dibuka otomatis: " + by.otherArchive.map(function (p) { return path.basename(p); }).join(", "));
    if (app === "ppro" && aeps.length && !plan.import.length && !plan.mogrt.length) plan.notes.push("Pack ini template After Effects - buka di AE, bukan Premiere.");
    return plan;
  }

  function uniqueDir(base) {
    if (!fs.existsSync(base)) return base;
    for (var i = 2; i < 100; i++) { var c = base + " (" + i + ")"; if (!fs.existsSync(c)) return c; }
    return base + " " + Date.now();
  }

  function writeSource(dir, o, srcName) {
    if (!o.itemUrl) return;
    try {
      var p = path.join(dir, "ENVATO-SOURCE.txt");
      var line = [
        "Envato Elements item: " + o.itemUrl,
        o.title ? "Title: " + o.title : null,
        "Downloaded file: " + srcName,
        "Imported: " + new Date().toISOString(),
        o.projectPath ? "Project: " + o.projectPath : null,
        "Licence: tercatat otomatis di workspace akun Envato yang men-download (app.envato.com > item > Licenses); buat licence baru di situ kalau perlu atas nama project/klien ini.",
        ""
      ].filter(function (x) { return x !== null; }).join("\n");
      fs.writeFileSync(p, line + (fs.existsSync(p) ? "\n" + fs.readFileSync(p, "utf8") : ""));
    } catch (e) {}
  }

  function installFonts(list) {
    var dir = WIN ? path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Windows", "Fonts") : path.join(os.homedir(), "Library", "Fonts");
    var done = [];
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    list.forEach(function (f) {
      var d = path.join(dir, path.basename(f));
      try { if (!fs.existsSync(d)) { fs.copyFileSync(f, d); done.push(path.basename(f)); } } catch (e) {}
    });
    return { dir: dir, installed: done, note: WIN ? "Windows: font per-user perlu didaftarkan; klik kanan > Install kalau belum muncul." : "Restart " + "aplikasi Adobe supaya font baru terbaca." };
  }

  // Main entry: resolve sources -> extract/copy into destRoot -> plans.
  function collect(o) {
    o = o || {};
    var destRoot = o.destRoot;
    var t0 = Date.now();
    var src = (o.paths && o.paths.length)
      ? Promise.resolve(o.paths.map(function (p) {
          p = String(p).replace(/^file:\/\//, "");
          if (p.charAt(0) === "~") p = path.join(os.homedir(), p.slice(1));
          var s = stat(p);
          return s ? { path: p, name: path.basename(p), dir: s.isDirectory() } : { path: p, missing: true, name: path.basename(p) };
        }))
      : findDownloads({ itemUrl: o.itemUrl, match: o.match, minutes: o.minutes, waitSeconds: o.waitSeconds, downloadsDir: o.downloadsDir });

    return src.then(function (list) {
      var missing = list.filter(function (e) { return e.missing; }).map(function (e) { return e.path; });
      list = list.filter(function (e) { return !e.missing; });
      if (!list.length) {
        return { ok: false, error: missing.length ? "path tidak ada: " + missing.join(", ")
          : "Belum ada download yang selesai di " + (o.downloadsDir || downloadsDir()) + (o.waitSeconds ? " setelah menunggu " + o.waitSeconds + " dtk" : "") +
            ". Panggil import_media {item_url, download: true} supaya Hermes yang download, atau minta user klik DOWNLOAD lalu panggil lagi dengan wait_seconds." };
      }
      try { fs.mkdirSync(destRoot, { recursive: true }); } catch (e) {}
      var plans = [], errors = [];
      return list.reduce(function (p, e) {
        return p.then(function () {
          var label = safeName(o.title && o.removeSources && list.length === 1 ? o.title : e.name);
          var inside = e.path.indexOf(destRoot + path.sep) === 0;
          if (kindOf(e.path) === "archive") {
            var dst = path.join(destRoot, label);
            var already = fs.existsSync(path.join(dst, ".hb-extracted"));
            if (!already && fs.existsSync(dst)) dst = uniqueDir(dst);
            var job = already ? Promise.resolve({ ok: true }) : unzip(e.path, dst);
            return job.then(function (r) {
              if (!r.ok) { errors.push(r.error); return; }
              try { fs.writeFileSync(path.join(dst, ".hb-extracted"), e.path + "\n"); } catch (x) {}
              if (o.removeSources) { try { fs.unlinkSync(e.path); } catch (x) {} }
              // one level of nested zips (common in Envato packs)
              var nested = walkFiles(dst).filter(function (f) { return kindOf(f) === "archive"; });
              return nested.reduce(function (q, z) {
                return q.then(function () {
                  var zd = z.replace(/\.zip$/i, "");
                  if (fs.existsSync(zd)) return;
                  return unzip(z, zd).then(function (rr) { if (rr.ok) { try { fs.unlinkSync(z); } catch (x) {} } else errors.push(rr.error); });
                });
              }, Promise.resolve()).then(function () {
                writeSource(dst, o, e.name);
                plans.push(planPack(dst, label, o.app));
              });
            });
          }
          if (o.copy === false || inside) {
            plans.push(planPack(e.path, label, o.app));
            return;
          }
          if (e.dir) {
            var dd = path.join(destRoot, label);
            return copyTree(e.path, dd).then(function () { writeSource(dd, o, e.name); plans.push(planPack(dd, label, o.app)); });
          }
          var loose = path.join(destRoot, o.itemUrl ? label : "Downloads");
          try { fs.mkdirSync(loose, { recursive: true }); } catch (x) {}
          var target = path.join(loose, e.name);
          var same = stat(target) && stat(target).size === stat(e.path).size;
          return (same ? Promise.resolve({ ok: true }) : copyP(e.path, target)).then(function (r) {
            if (!r.ok) { errors.push("gagal copy " + e.name + ": " + r.error); return; }
            writeSource(loose, o, e.name);
            plans.push(planPack(target, o.itemUrl ? label : "Downloads", o.app));
          });
        });
      }, Promise.resolve()).then(function () {
        var fonts = [];
        plans.forEach(function (pl) { fonts = fonts.concat(pl.fonts); });
        var fontRes = o.installFonts && fonts.length ? installFonts(fonts) : null;
        return { ok: true, sources: list.map(function (e) { return e.path; }), destRoot: destRoot, plans: plans,
          errors: errors, missing: missing, fonts: fontRes, ms: Date.now() - t0 };
      });
    });
  }

  // ---------------------------------------------------------
  // AUTO DOWNLOAD: drive the user's own logged-in browser over CDP
  // (Envato has no download API). The new Envato app licenses an item to
  // the account's workspace the moment it is downloaded, so one click on
  // the item's Download button is all a human would do. No cookies are read,
  // no credentials typed: a logged-out browser is left on the login page.
  // ---------------------------------------------------------
  var http = require("http");
  var crypto = require("crypto");

  // Minimal RFC 6455 client. Hand-rolled on purpose: CEP's Node may lack a
  // WebSocket global, and a browser WebSocket always sends an Origin header,
  // which Chrome's DevTools endpoint rejects (403) unless allow-listed.
  function wsConnect(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var u = new URL(url), done = false;
      var req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers: {
        "Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64") } });
      req.setTimeout(timeoutMs || 5000, function () { if (done) return; done = true; req.destroy(); reject(new Error("CDP websocket timeout")); });
      req.on("error", function (e) { if (done) return; done = true; reject(e); });
      req.on("response", function (res) { if (done) return; done = true; res.resume(); reject(new Error("CDP websocket HTTP " + res.statusCode)); });
      req.on("upgrade", function (res, sock, head) {
        if (done) { sock.destroy(); return; }
        done = true; req.setTimeout(0);
        var buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0), frags = [], subs = [], closers = [], closed = false;
        sock.setNoDelay(true);
        function frame(op, data) {
          if (closed) return;
          var len = data.length, hdr;
          if (len < 126) { hdr = Buffer.alloc(2); hdr[1] = 128 | len; }
          else if (len < 65536) { hdr = Buffer.alloc(4); hdr[1] = 128 | 126; hdr.writeUInt16BE(len, 2); }
          else { hdr = Buffer.alloc(10); hdr[1] = 128 | 127; hdr.writeUInt32BE(Math.floor(len / 4294967296), 2); hdr.writeUInt32BE(len >>> 0, 6); }
          hdr[0] = 128 | op;
          var mk = crypto.randomBytes(4), out = Buffer.alloc(len);
          for (var i = 0; i < len; i++) out[i] = data[i] ^ mk[i & 3];
          sock.write(Buffer.concat([hdr, mk, out]));
        }
        function shut() {
          if (closed) return; closed = true;
          try { sock.destroy(); } catch (e) {}
          closers.forEach(function (f) { try { f(); } catch (e) {} });
        }
        function parse() {
          while (buf.length >= 2) {
            var b0 = buf[0], b1 = buf[1], len = b1 & 127, off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6); off = 10; }
            var masked = b1 & 128;
            if (masked) off += 4;
            if (buf.length < off + len) return;
            var pay = Buffer.from(buf.slice(off, off + len));
            if (masked) { var mk = buf.slice(off - 4, off); for (var i = 0; i < pay.length; i++) pay[i] ^= mk[i & 3]; }
            buf = buf.slice(off + len);
            var op = b0 & 15;
            if (op === 8) { shut(); return; }
            if (op === 9) { frame(10, pay); continue; }
            if (op !== 0 && op !== 1 && op !== 2) continue;
            frags.push(pay);
            if (!(b0 & 128)) continue;
            var msg = null;
            try { msg = JSON.parse(Buffer.concat(frags).toString("utf8")); } catch (e) {}
            frags = [];
            if (msg) subs.forEach(function (f) { try { f(msg); } catch (e) {} });
          }
        }
        sock.on("data", function (d) { buf = Buffer.concat([buf, d]); parse(); });
        sock.on("close", shut);
        sock.on("error", shut);
        parse();
        resolve({
          send: function (obj) { frame(1, Buffer.from(JSON.stringify(obj), "utf8")); },
          onMessage: function (f) { subs.push(f); },
          onClose: function (f) { closers.push(f); },
          close: function () { if (!closed) { try { frame(8, Buffer.alloc(0)); } catch (e) {} } shut(); },
          isClosed: function () { return closed; }
        });
      });
      req.end();
    });
  }

  // CDP client on the browser endpoint (flatten sessions).
  function cdpClient(wsUrl) {
    return wsConnect(wsUrl, 5000).then(function (ws) {
      var seq = 0, pending = {}, listeners = [];
      ws.onMessage(function (m) {
        if (m.id && pending[m.id]) {
          var p = pending[m.id]; delete pending[m.id];
          if (m.error) p.reject(new Error(m.error.message || "CDP error")); else p.resolve(m.result || {});
          return;
        }
        if (m.method) listeners.forEach(function (f) { f(m.method, m.params || {}, m.sessionId); });
      });
      ws.onClose(function () {
        Object.keys(pending).forEach(function (k) { pending[k].reject(new Error("browser menutup koneksi CDP")); });
        pending = {};
      });
      return {
        call: function (method, params, sessionId, timeoutMs) {
          return new Promise(function (resolve, reject) {
            if (ws.isClosed()) return reject(new Error("koneksi CDP sudah tertutup"));
            var id = ++seq, msg = { id: id, method: method, params: params || {} };
            if (sessionId) msg.sessionId = sessionId;
            var t = setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error(method + " timeout")); } }, timeoutMs || 15000);
            pending[id] = { resolve: function (r) { clearTimeout(t); resolve(r); }, reject: function (e) { clearTimeout(t); reject(e); } };
            ws.send(msg);
          });
        },
        on: function (f) { listeners.push(f); },
        close: function () { ws.close(); }
      };
    });
  }

  function httpJson(url, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (done) return; done = true; resolve(v); }
      try {
        var req = http.get(url, function (res) {
          var chunks = [];
          res.on("data", function (c) { chunks.push(c); });
          res.on("end", function () { try { fin(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { fin(null); } });
        });
        req.setTimeout(timeoutMs || 1500, function () { req.destroy(); fin(null); });
        req.on("error", function () { fin(null); });
      } catch (e) { fin(null); }
    });
  }

  // Where a debuggable, user-owned browser may listen: $HB_ENVATO_CDP, the
  // Hermes browser.cdp_url of any profile (the browser Hermes already
  // drives), then Chrome's conventional 9222.
  function cdpCandidates(extra) {
    var out = [];
    function add(u) {
      u = String(u || "").trim().replace(/^["']|["']$/g, "");
      if (!u) return;
      if (/^\d+$/.test(u)) u = "http://127.0.0.1:" + u;
      if (out.indexOf(u) < 0) out.push(u);
    }
    [].concat(extra || []).forEach(add);
    String(process.env.HB_ENVATO_CDP || "").split(/[,\s]+/).forEach(add);
    var root = WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes") : path.join(os.homedir(), ".hermes");
    var cfgs = [path.join(root, "config.yaml")];
    try { fs.readdirSync(path.join(root, "profiles")).forEach(function (p) { cfgs.push(path.join(root, "profiles", p, "config.yaml")); }); } catch (e) {}
    cfgs.forEach(function (f) {
      try {
        var m = fs.readFileSync(f, "utf8").match(/^browser:[ \t]*\r?\n(?:[ \t]+.*\r?\n|[ \t]*\r?\n)*?[ \t]+cdp_url:[ \t]*(\S+)/m);
        if (m) add(m[1]);
      } catch (e) {}
    });
    add("http://127.0.0.1:9222");
    return out;
  }

  // First endpoint that is a real browser (not an Electron app such as
  // TradingView, not headless) -> its browser websocket URL.
  function findBrowser(cands) {
    var i = 0, tried = [];
    function next() {
      if (i >= cands.length) return Promise.resolve({ ok: false, tried: tried });
      var c = cands[i++];
      if (/^wss?:/.test(c)) return Promise.resolve({ ok: true, ws: c, endpoint: c });
      var base = c.replace(/\/+$/, "").replace(/\/json(\/version)?$/, "");
      return httpJson(base + "/json/version", 1500).then(function (v) {
        if (!v || !v.webSocketDebuggerUrl) { tried.push(base + " (mati)"); return next(); }
        var ua = String(v["User-Agent"] || "") + " " + String(v.Browser || "");
        if (/Electron|TradingView|Headless/i.test(ua)) { tried.push(base + " (bukan browser user)"); return next(); }
        return { ok: true, ws: v.webSocketDebuggerUrl, endpoint: base, browser: v.Browser };
      });
    }
    return next();
  }

  // Runs inside the Envato tab. PICK opens the variant menu (stock video:
  // 4K / 1080P ...) and chooses one; CLICK presses the item's Download.
  // Envato's markup has no stable ids on app.envato.com, so match by text.
  var PAGE_JS = [
    "(async function (MODE, WANT) {",
    "  var T = function (e) { return (e.innerText || e.textContent || '').trim().replace(/\\s+/g, ' '); };",
    "  var V = function (e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };",
    "  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };",
    "  var href = location.href, host = location.hostname;",
    "  var signIn = [].slice.call(document.querySelectorAll('a,button')).some(function (e) { return V(e) && /^(sign in|log in|masuk)$/i.test(T(e)); });",
    "  if (/account\\.envato\\.com|sign[_-]?in|\\/login/i.test(href)) return { s: 'login', url: href };",
    "  if (document.readyState === 'loading') return { s: 'loading', url: href };",
    "  if (/(^|\\.)elements\\.envato\\.com$/.test(host)) {",
    "    var eb = document.querySelector('[data-testid=button-download]');",
    "    if (!eb) return { s: signIn ? 'login' : 'loading', url: href };",
    "    if (MODE !== 'click') return { s: 'ready', where: 'elements', url: href };",
    "    eb.click(); return { s: 'clicked', where: 'elements', label: T(eb), url: href };",
    "  }",
    "  if (!/(^|\\.)app\\.envato\\.com$/.test(host)) return { s: 'other', url: href };",
    "  var dl = function () { return [].slice.call(document.querySelectorAll('button')).filter(function (e) { return V(e) && !e.disabled && /^download\\b/i.test(T(e)) && !/preview/i.test(T(e)); })[0]; };",
    "  var b = dl();",
    "  if (!b) return { s: signIn ? 'login' : 'loading', url: href };",
    "  if (MODE === 'pick') {",
    "    var p = b.parentElement, i = 0;",
    "    while (p && p.querySelectorAll('button').length < 2 && i < 4) { p = p.parentElement; i++; }",
    "    var chev = p ? [].slice.call(p.querySelectorAll('button')).filter(function (x) { return x !== b && V(x) && !T(x); })[0] : null;",
    "    if (!chev) return { s: 'novariant', label: T(b) };",
    "    chev.click(); await sleep(900);",
    "    var dlg = [].slice.call(document.querySelectorAll('[role=dialog],[role=menu],[role=listbox]')).filter(function (d) { return V(d) && /\\d/.test(T(d)); });",
    "    var opts = dlg.length ? [].slice.call(dlg[dlg.length - 1].querySelectorAll('button,[role=option],[role=menuitem],[role=menuitemradio]')).filter(V) : [];",
    "    var names = opts.map(T), w = String(WANT || '').toLowerCase().replace(/\\s+/g, '');",
    "    var hit = opts.filter(function (o) { return T(o).toLowerCase().replace(/\\s+/g, '').indexOf(w) >= 0; })[0];",
    "    if (!hit) { chev.click(); await sleep(300); return { s: 'nomatch', options: names, label: T(b) }; }",
    "    hit.click(); await sleep(500);",
    "    return { s: 'picked', picked: T(hit), options: names };",
    "  }",
    "  if (MODE !== 'click') return { s: 'ready', where: 'app', label: T(b), url: href };",
    "  b.click(); return { s: 'clicked', where: 'app', label: T(b), url: href };",
    "})"
  ].join("\n");

  var VISIBLE_JS = "(function(){try{" +
    "Object.defineProperty(Document.prototype,'visibilityState',{configurable:true,get:function(){return 'visible';}});" +
    "Object.defineProperty(Document.prototype,'hidden',{configurable:true,get:function(){return false;}});" +
    "Document.prototype.hasFocus=function(){return true;};" +
    "window.requestAnimationFrame=function(cb){return setTimeout(function(){cb(performance.now());},16);};" +
    "window.cancelAnimationFrame=function(i){clearTimeout(i);};" +
    "}catch(e){}})();";

  function dialogText() {
    return "[].slice.call(document.querySelectorAll('[role=dialog],[role=alertdialog]')).filter(function (d) { var r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map(function (d) { return (d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 300); }).filter(Boolean).join(' | ')";
  }

  // Newest finished file in dir that started after `since` and carries the
  // browser's suggested name (Chrome may add " (1)").
  function landedFile(dir, suggested, since) {
    var stem = String(suggested || "").replace(/\.[a-z0-9]{1,5}$/i, "").toLowerCase();
    var hit = scanDownloads(dir, since - 2000).filter(function (e) { return !e.dir && (!stem || e.name.toLowerCase().indexOf(stem) === 0); });
    return hit.length ? hit[0].path : null;
  }

  // o: {itemUrl, downloadsDir, resolution, timeoutMs, cdp:[urls], log(fn)}
  // -> {ok, mode:'cdp', file, name, bytes, state} | {ok:false, nocdp|login|stuck|inProgress, ...}
  function autoDownload(o) {
    o = o || {};
    var itemUrl = String(o.itemUrl || "");
    if (!/^https:\/\/(elements|app)\.envato\.com\//.test(itemUrl)) return Promise.resolve({ ok: false, error: "item_url harus link elements.envato.com / app.envato.com" });
    var dir = o.downloadsDir || downloadsDir();
    var t0 = Date.now(), deadline = t0 + Math.max(20000, o.timeoutMs || 200000);
    var log = typeof o.log === "function" ? o.log : function () {};
    var want = o.resolution === undefined || o.resolution === null || o.resolution === "" ? "1080" : String(o.resolution);
    if (/^(4k|uhd|2160p?)$/i.test(want)) want = "4K";
    if (/^(hd|fhd|full ?hd|1080p?)$/i.test(want)) want = "1080";
    if (/^(default|original|max|best)$/i.test(want)) want = "";

    return findBrowser(cdpCandidates(o.cdp)).then(function (br) {
      if (!br.ok) return { ok: false, nocdp: true, tried: br.tried };
      var cdp = null, target = null, child = null, sid = null, dlState = { begun: null, done: null, bytes: 0, total: 0, state: "" }, clickAt = 0;
      function cleanup(keepTab) {
        var steps = [];
        if (cdp) steps.push(cdp.call("Browser.setDownloadBehavior", { behavior: "default" }).catch(function () {}));
        if (cdp) steps.push(cdp.call("Target.setDiscoverTargets", { discover: false }).catch(function () {}));
        if (cdp && target && !keepTab) steps.push(cdp.call("Target.closeTarget", { targetId: target }).catch(function () {}));
        if (cdp && target && keepTab) steps.push(cdp.call("Target.activateTarget", { targetId: target }).catch(function () {}));
        return Promise.all(steps).then(function () { if (cdp) cdp.close(); });
      }
      // Our tab stays in the background so AE keeps focus, but Envato only
      // acts while the page is visible (rAF/visibility gated: the click is
      // queued until the tab is shown). Make this one tab believe it is
      // visible; the user's own tabs are untouched.
      function awake(s) {
        return cdp.call("Page.enable", {}, s).then(function () {
          return cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: VISIBLE_JS }, s);
        }).then(function () {
          return cdp.call("Runtime.evaluate", { expression: VISIBLE_JS }, s).catch(function () {});
        });
      }
      function evalPage(expr, awaitP) {
        return cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: !!awaitP, userGesture: true }, sid, 15000)
          .then(function (r) { return r && r.result ? r.result.value : null; })
          .catch(function () { return null; });   // navigation in progress
      }
      function step(mode) { return evalPage(PAGE_JS + "(" + JSON.stringify(mode) + "," + JSON.stringify(want) + ")", true); }
      function waitBegin(ms) {
        var until = Date.now() + ms;
        return (function poll() {
          if (dlState.begun) return Promise.resolve(true);
          if (Date.now() >= until) return Promise.resolve(false);
          return sleep(300).then(poll);
        })();
      }
      function finishDownload() {
        return (function poll() {
          if (dlState.state === "completed" || dlState.state === "canceled") return Promise.resolve();
          if (Date.now() >= deadline) return Promise.resolve();
          return sleep(500).then(poll);
        })().then(function () {
          var name = dlState.begun.suggestedFilename;
          if (dlState.state === "canceled") return cleanup(false).then(function () { return { ok: false, error: "download " + name + " dibatalkan di browser", browser: br.endpoint }; });
          if (dlState.state !== "completed") {
            return cleanup(false).then(function () {
              var pct = dlState.total ? Math.round(100 * dlState.bytes / dlState.total) : null;
              return { ok: false, inProgress: true, name: name, progress: pct, bytes: dlState.bytes, total: dlState.total, browser: br.endpoint,
                match: name.replace(/\.[a-z0-9]{1,5}$/i, "") };
            });
          }
          // the rename from .crdownload lands a moment after the event
          var tries = 0;
          return (function look() {
            var f = landedFile(dir, name, clickAt);
            if (f || tries++ > 20) return cleanup(false).then(function () {
              return f ? { ok: true, mode: "cdp", file: f, name: path.basename(f), bytes: dlState.total || dlState.bytes, browser: br.endpoint, ms: Date.now() - t0 }
                       : { ok: false, error: "download selesai tapi file " + name + " tidak ketemu di " + dir, browser: br.endpoint };
            });
            return sleep(250).then(look);
          })();
        });
      }

      return cdpClient(br.ws).then(function (c) {
        cdp = c;
        cdp.on(function (method, p) {
          if (method === "Target.targetInfoChanged" && p.targetInfo && p.targetInfo.targetId === target) log("nav " + Math.round((Date.now() - t0) / 1000) + "s " + p.targetInfo.url);
          if (method === "Browser.downloadWillBegin" && clickAt && !dlState.begun) { dlState.begun = p; log("Envato: download " + p.suggestedFilename + " mulai"); }
          if (method === "Browser.downloadProgress" && dlState.begun && p.guid === dlState.begun.guid) {
            dlState.bytes = p.receivedBytes || 0; dlState.total = p.totalBytes || dlState.total; dlState.state = p.state;
          }
          // elements.envato.com opens the app.envato.com item in a NEW tab
          if (method === "Target.targetCreated" && p.targetInfo && p.targetInfo.type === "page" && target && p.targetInfo.openerId === target) child = p.targetInfo.targetId;
        });
        return cdp.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true })
          .then(function () { return cdp.call("Target.setDiscoverTargets", { discover: true }); })
          .then(function () { return cdp.call("Target.createTarget", { url: "about:blank", background: true }); })
          .then(function (r) { target = r.targetId; return cdp.call("Target.attachToTarget", { targetId: target, flatten: true }); })
          .then(function (r) { sid = r.sessionId; return awake(sid); })
          .then(function () { return cdp.call("Page.navigate", { url: itemUrl }, sid); });
      }).then(function () {
        var clickedElements = false, picked = null, options = null, pickedDone = false, last = null;
        // follow the tab the elements page opened; drop the elements tab
        function adopt() {
          var old = target;
          target = child; child = null;
          return cdp.call("Target.attachToTarget", { targetId: target, flatten: true }).then(function (r) {
            sid = r.sessionId;
            return awake(sid);
          }).then(function () {
            return cdp.call("Target.closeTarget", { targetId: old }).catch(function () {});
          });
        }
        function waitChild(ms) {
          var until = Date.now() + ms;
          return (function poll() {
            if (dlState.begun || child) return Promise.resolve();
            if (Date.now() >= until) return Promise.resolve();
            return sleep(250).then(poll);
          })();
        }
        function loop() {
          if (Date.now() >= deadline) return cleanup(true).then(function () { return { ok: false, stuck: true, error: "halaman Envato tidak siap dalam waktu (state " + (last && last.s) + ")", url: last && last.url, browser: br.endpoint }; });
          if (child) return adopt().then(loop);
          return step("look").then(function (st) {
            last = st || last;
            if (!st || st.s === "loading" || st.s === "other") return sleep(700).then(loop);
            if (st.s === "login") return cleanup(true).then(function () { return { ok: false, login: true, url: st.url, browser: br.endpoint }; });
            if (st.where === "elements") {
              if (clickedElements && Date.now() - clickedElements < 35000) return sleep(700).then(loop);   // navigating to app.envato.com
              if (clickedElements) {
                // still on the old page: a sign-in or licence modal is in the way
                return evalPage(dialogText()).then(function (dt) {
                  return cleanup(true).then(function () {
                    return { ok: false, stuck: true, login: /sign in|log in|create account/i.test(dt || ""), dialog: dt || "", url: st.url, browser: br.endpoint,
                      error: "Tombol Download Envato tidak membuka halaman download" + (dt ? " - tampil: " + dt : "") };
                  });
                });
              }
              clickedElements = Date.now(); clickAt = clickAt || Date.now();
              return step("click").then(function () { return waitChild(8000); }).then(function () { return dlState.begun ? finishDownload() : loop(); });
            }
            // app.envato.com item page
            clickAt = clickAt || Date.now();   // a variant pick may start the download itself
            var pre = Promise.resolve();
            if (want && !pickedDone) {
              pickedDone = true;
              pre = step("pick").then(function (r) {
                if (r && r.s === "picked") { picked = r.picked; options = r.options; }
                else if (r && r.s === "nomatch") options = r.options;
              });
            }
            function tag(r) { if (picked) r.variant = picked; if (options) r.variants = options; return r; }
            return pre.then(function () {
              // picking a variant might already start it; never click twice
              return waitBegin(picked ? 4000 : 0);
            }).then(function (b) {
              if (b) return finishDownload().then(tag);
              return step("click").then(function () { return waitBegin(20000); }).then(function (b2) {
                if (b2) return finishDownload().then(tag);
                return evalPage(dialogText()).then(function (dt) {
                  return cleanup(true).then(function () {
                    return { ok: false, stuck: true, dialog: dt || "", url: last && last.url, browser: br.endpoint,
                      error: "Download diklik tapi browser tidak mulai download dalam 20 dtk" + (dt ? " - Envato menampilkan: " + dt : "") };
                  });
                });
              });
            });
          });
        }
        return loop();
      }).catch(function (e) {
        return cleanup(true).then(function () { return { ok: false, error: "CDP: " + (e && e.message || e), browser: br.endpoint }; });
      });
    });
  }

  function openInBrowser(url) {
    try {
      if (WIN) cp.spawn("cmd.exe", ["/d", "/s", "/c", "start", "\"\"", "\"" + url + "\""], { detached: true, windowsVerbatimArguments: true, windowsHide: true }).unref();
      else cp.spawn("/usr/bin/open", [url], { detached: true }).unref();
      return true;
    } catch (e) { return false; }
  }

  // import_media {download:true}: get the file before collect(). Returns
  // {paths?, match?, waitSeconds, info} to feed collect, or {stop: result}.
  function prepareDownload(a, ctx) {
    ctx = ctx || {};
    var wait = Math.min(150, Math.max(0, a.wait_seconds || 0));
    if (!a.download || !a.item_url || (a.paths && a.paths.length)) return Promise.resolve({ waitSeconds: wait });
    var NS = global.HBEnvatoSession;
    if (NS && ctx.destRoot && !ctx.browserOnly) {
      return NS.fetchItem({ itemUrl: a.item_url, projectName: ctx.projectName || "Feugee", resolution: a.resolution,
        dir: path.join(ctx.destRoot, ".downloads"), waitMs: ctx.waitMs || 200000 }).then(function (j) {
        if (j.state === "done") return { paths: [j.file], removeSources: true, waitSeconds: 0, info: { mode: "native", file: path.basename(j.file), format: j.format, licence_project: ctx.projectName, mb: Math.round(j.received / 104857.6) / 10, seconds: Math.round((j.ms || 0) / 1000) } };
        if (j.state === "downloading" || j.state === "licensing") {
          var p = NS.progress(j);
          return { stop: { ok: true, data: { in_progress: true, download: p, hint: "Download Envato masih jalan di background (" + (p.percent != null ? p.percent + "%" : p.received_mb + " MB") + (p.eta_s != null ? ", sisa ~" + p.eta_s + " dtk" : "") + "). Panggil import_media lagi dengan item_url + download: true yang sama untuk lanjut import (tidak lisensi/download ulang)." } } };
        }
        if (j.needLogin) return { stop: { ok: false, needLogin: true, error: j.error } };
        if (j.infra) return prepareDownload(a, { downloadsDir: ctx.downloadsDir, timeoutMs: ctx.timeoutMs, browserOnly: true });
        return { stop: { ok: false, error: j.error } };
      });
    }
    return autoDownload({ itemUrl: a.item_url, downloadsDir: ctx.downloadsDir, resolution: a.resolution, timeoutMs: ctx.timeoutMs || 200000, cdp: ctx.cdp, log: ctx.log })
      .then(function (d) {
        if (d.ok) return { paths: [d.file], waitSeconds: 0, info: { mode: "browser", file: d.name, variant: d.variant, variants: d.variants, seconds: Math.round(d.ms / 1000) } };
        if (d.inProgress) {
          return { stop: { ok: false, error: "Download " + d.name + " masih jalan (" + (d.progress === null ? "?" : d.progress) + "%) - file besar. Panggil lagi import_media {item_url, match: " + JSON.stringify(d.match) + ", wait_seconds: 150} (tanpa download) supaya tidak download dua kali." } };
        }
        if (d.login) return { waitSeconds: 150, info: { mode: "login", note: "Browser (" + d.browser + ") belum login Envato: tab login sudah dibuka. User login lalu klik DOWNLOAD; tool ini menunggu filenya." } };
        if (d.nocdp) {
          var opened = openInBrowser(a.item_url);
          return { waitSeconds: 150, info: { mode: "manual", note: (opened ? "Halaman item dibuka di browser default. " : "") + "Tidak ada browser yang bisa dikendalikan (CDP), jadi user yang klik DOWNLOAD; tool ini menunggu filenya. Untuk full otomatis: jalankan Chrome/Ardia dengan --remote-debugging-port lalu isi browser.cdp_url di config Hermes atau env HB_ENVATO_CDP." } };
        }
        return { waitSeconds: 150, info: { mode: "manual", note: (d.error || "auto-download gagal") + ". Tab item dibiarkan terbuka: klik DOWNLOAD manual; tool ini menunggu filenya." } };
      });
  }

  global.HBEnvato = {
    MCP_URL: MCP_URL,
    ITEM_TYPES: ITEM_TYPES,
    toolsFor: toolsFor,
    rpc: rpc,
    search: search,
    collect: collect,
    autoDownload: autoDownload,
    prepareDownload: prepareDownload,
    cdpCandidates: cdpCandidates,
    // exposed for tests
    _itemId: itemId,
    _slugOf: slugOf,
    _planPack: planPack,
    _groupSequences: groupSequences,
    _aepRank: aepRank,
    _scanDownloads: scanDownloads,
    _rpcReply: rpcReply,
    downloadsDir: downloadsDir
  };
})(typeof window !== "undefined" ? window : global);
