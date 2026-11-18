/* =========================================================
   HERMES BRIDGE - MODEL CATALOG + PICKER
   Turns ACP availableModels into grouped, readable entries,
   keeps favourites / recents / health marks, and renders the
   picker. Pure logic lives on HBModels.* so it can be tested
   in plain Node.
   ========================================================= */
(function (global) {
  "use strict";

  var PROVIDERS = {
    anthropic: { label: "Anthropic", order: 1, note: "API resmi" },
    pecut:     { label: "Pecut",     order: 2, note: "proxy" },
    "9router": { label: "9router",   order: 3, note: "lokal :20129" },
    bandel:    { label: "Bandel",    order: 4, note: "proxy" },
    nous:      { label: "Nous",      order: 5, note: "Portal" }
  };

  var WORDS = {
    claude: "Claude", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable",
    gpt: "GPT", glm: "GLM", deepseek: "DeepSeek", gemini: "Gemini", kimi: "Kimi",
    qwen: "Qwen", grok: "Grok", mimo: "MiMo", oss: "OSS", pro: "Pro", flash: "Flash",
    mod: "Mod", max: "Max", preview: "Preview", code: "Code", highspeed: "Highspeed",
    agent: "Agent", thinking: "Thinking", vision: "Vision", exp: "Exp", high: "High",
    medium: "Medium", low: "Low", extra: "Extra", luna: "Luna", sol: "Sol",
    terra: "Terra", astra: "Astra", muse: "Muse", spark: "Spark"
  };

  // "anthropic:claude-opus-5-5" -> {provider:"anthropic", model:"claude-opus-5-5"}
  // "custom:pecut:pecut/deepseek-v4.1-flash" -> {provider:"pecut", model:"pecut/deepseek-v4.1-flash"}
  function parse(id) {
    id = String(id || "");
    var m = id.match(/^custom:([^:\/]+):(.+)$/);
    if (m) return { provider: m[1], model: m[2] };
    m = id.match(/^([a-z0-9_-]+):(.+)$/i);
    if (m && m[1] !== "custom") return { provider: m[1], model: m[2] };
    return null; // malformed (e.g. "custom:pecut/pecut/x" from a broken config default)
  }

  function prettify(model) {
    var s = String(model).replace(/^[a-z0-9_-]+\//i, "");   // pecut/ ag/ anthropic/
    s = s.replace(/-(\d{8})$/, "");                          // date suffix
    s = s.replace(/(^|-)(\d+)-(\d)(?=-|$)/g, "$1$2.$3");     // opus-5-5 -> opus-5.5
    return s.split("-").map(function (w) {
      var k = w.toLowerCase();
      if (WORDS[k]) return WORDS[k];
      if (/^v?\d/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  function entry(raw) {
    var p = parse(raw.modelId);
    if (!p) return null;
    var prov = PROVIDERS[p.provider] || { label: p.provider, order: 50, note: "" };
    return {
      id: raw.modelId,
      provider: p.provider,
      providerLabel: prov.label,
      providerOrder: prov.order,
      providerNote: prov.note,
      label: prettify(p.model),
      family: (p.model.match(/(claude|gpt|glm|deepseek|gemini|kimi|qwen|grok|mimo|muse)/i) || ["", "other"])[1].toLowerCase()
    };
  }

  // availableModels -> [{provider, label, note, items:[entry]}], deduped by label per provider
  function catalog(available) {
    var groups = {}, order = [];
    (available || []).forEach(function (raw) {
      var e = entry(raw);
      if (!e) return;
      var g = groups[e.provider];
      if (!g) {
        g = groups[e.provider] = { provider: e.provider, label: e.providerLabel, note: e.providerNote, order: e.providerOrder, items: [], seen: {} };
        order.push(g);
      }
      if (g.seen[e.label]) return;
      g.seen[e.label] = 1;
      g.items.push(e);
    });
    order.sort(function (a, b) { return a.order - b.order; });
    order.forEach(function (g) { delete g.seen; });
    return order;
  }

  function flat(groups) {
    var out = [];
    groups.forEach(function (g) { out = out.concat(g.items); });
    return out;
  }

  function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim(); }

  // Every query word must appear in "label provider id". Higher = better.
  function score(e, q) {
    q = norm(q);
    if (!q) return 1;
    var hay = norm(e.label + " " + e.providerLabel + " " + e.id);
    var words = q.split(" "), sc = 0;
    for (var i = 0; i < words.length; i++) {
      var at = hay.indexOf(words[i]);
      if (at < 0) return 0;
      sc += at === 0 ? 3 : 1;
    }
    if (norm(e.label) === q) sc += 10;
    if (e.provider === "anthropic") sc += 0.5;
    return sc;
  }

  function search(list, q) {
    return list.map(function (e) { return { e: e, s: score(e, q) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (x) { return x.e; });
  }

  // Provider failures surface as ordinary assistant text, not as an RPC error.
  var FAIL_RE = /(Provider said:\s*HTTP\s*\d{3})|(rejected your API key)|(credits? (are )?exhausted|requires available credits)|(Requested model is not available)|(model can't be reached)/i;
  function detectFailure(text) {
    var m = String(text || "").match(FAIL_RE);
    if (!m) return null;
    var code = String(text).match(/HTTP\s*(\d{3})/);
    return code ? "HTTP " + code[1] : m[0];
  }

  // ---------------------------------------------------------
  // STORE (favourites, recents, health) - localStorage
  // ---------------------------------------------------------
  var DEFAULT_FAVS = [
    "custom:pecut:pecut/deepseek-v4.1-flash",
    "anthropic:claude-opus-5-5",
    "anthropic:claude-sonnet-5",
    "custom:pecut:pecut/gpt-6-sol"
  ];
  var BAD_TTL = 6 * 3600 * 1000;

  function Store(ls) {
    this.ls = ls || (typeof localStorage !== "undefined" ? localStorage : null);
  }
  Store.prototype._get = function (k, d) {
    try { var v = this.ls && this.ls.getItem("hb.m." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
  };
  Store.prototype._set = function (k, v) { try { this.ls && this.ls.setItem("hb.m." + k, JSON.stringify(v)); } catch (e) {} };

  Store.prototype.favs = function () { return this._get("favs", DEFAULT_FAVS.slice()); };
  Store.prototype.isFav = function (id) { return this.favs().indexOf(id) >= 0; };
  Store.prototype.toggleFav = function (id) {
    var f = this.favs(), i = f.indexOf(id);
    if (i >= 0) f.splice(i, 1); else f.push(id);
    this._set("favs", f.slice(0, 8));
    return i < 0;
  };

  Store.prototype.recents = function () { return this._get("recent", []); };
  Store.prototype.pushRecent = function (id) {
    var r = this.recents().filter(function (x) { return x !== id; });
    r.unshift(id);
    this._set("recent", r.slice(0, 5));
  };

  Store.prototype.health = function (id) {
    var h = this._get("health", {})[id];
    if (!h) return null;
    if (Date.now() - h.at > BAD_TTL) return null;
    return h;
  };
  Store.prototype.markBad = function (id, why) {
    var h = this._get("health", {});
    h[id] = { at: Date.now(), why: why };
    this._set("health", h);
  };
  Store.prototype.markGood = function (id) {
    var h = this._get("health", {});
    if (h[id]) { delete h[id]; this._set("health", h); }
  };

  // ---------------------------------------------------------
  // PICKER (DOM)
  // ---------------------------------------------------------
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var SVG_STAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 3.2 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>';

  function Picker(opts) {
    this.root = opts.root;           // container element (hidden by default)
    this.store = opts.store;
    this.onPick = opts.onPick;
    this.getCurrent = opts.getCurrent;
    this.groups = [];
    this.list = [];
    this.byId = {};
    this.cursor = 0;
    this.visible = [];
    this.collapsed = { bandel: true, "9router": true };
    this._build();
  }

  Picker.prototype.setModels = function (available) {
    var self = this;
    this.groups = catalog(available);
    this.list = flat(this.groups);
    this.byId = {};
    this.list.forEach(function (e) { self.byId[e.id] = e; });
    if (this.isOpen()) this.render();
  };

  Picker.prototype.get = function (id) { return this.byId[id] || null; };

  Picker.prototype._build = function () {
    var self = this;
    this.root.innerHTML =
      '<input class="hb-msearch" type="text" placeholder="Cari model... (opus, deepseek, gpt)" spellcheck="false">' +
      '<div class="hb-mlist"></div>' +
      '<div class="hb-mfoot"><span>Enter pilih - Esc tutup - klik bintang = favorit</span><span class="hb-mcount"></span></div>';
    this.search = this.root.querySelector(".hb-msearch");
    this.listEl = this.root.querySelector(".hb-mlist");
    this.countEl = this.root.querySelector(".hb-mcount");

    this.search.addEventListener("input", function () { self.cursor = 0; self.render(); });
    this.search.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); self.move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); self.move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); var x = self.visible[self.cursor]; if (x) self.pick(x.id); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); self.close(); }
    });
    this.listEl.addEventListener("click", function (e) {
      var star = e.target.closest(".hb-mstar");
      var head = e.target.closest(".hb-mhead");
      var row = e.target.closest(".hb-mrow");
      e.stopPropagation();
      if (star && row) {
        self.store.toggleFav(row.getAttribute("data-id"));
        self.render();
        if (self.onFavsChange) self.onFavsChange();
        return;
      }
      if (head) {
        var p = head.getAttribute("data-p");
        self.collapsed[p] = !self.collapsed[p];
        self.render();
        return;
      }
      if (row) self.pick(row.getAttribute("data-id"));
    });
  };

  Picker.prototype.isOpen = function () { return !this.root.hidden; };
  Picker.prototype.open = function (q) {
    this.root.hidden = false;
    this.search.value = q || "";
    this.cursor = 0;
    this.render();
    var self = this;
    setTimeout(function () { self.search.focus(); }, 0);
  };
  Picker.prototype.close = function () { this.root.hidden = true; if (this.onClose) this.onClose(); };
  Picker.prototype.toggle = function () { if (this.isOpen()) this.close(); else this.open(); };

  Picker.prototype.pick = function (id) {
    this.close();
    if (id && id !== this.getCurrent()) this.onPick(id);
  };

  Picker.prototype.move = function (d) {
    if (!this.visible.length) return;
    this.cursor = (this.cursor + d + this.visible.length) % this.visible.length;
    this.render();
    var on = this.listEl.querySelector(".hb-mrow.cur");
    if (on) on.scrollIntoView({ block: "nearest" });
  };

  Picker.prototype._row = function (e, idx) {
    var cur = this.getCurrent() === e.id;
    var bad = this.store.health(e.id);
    var fav = this.store.isFav(e.id);
    return '<div class="hb-mrow' + (cur ? " on" : "") + (idx === this.cursor ? " cur" : "") + (bad ? " bad" : "") +
      '" data-id="' + esc(e.id) + '" title="' + esc(e.id + (bad ? "\nGagal terakhir: " + bad.why : "")) + '">' +
      '<i class="dot"></i><span class="nm">' + esc(e.label) + "</span>" +
      (bad ? '<b class="warn">' + esc(bad.why) + "</b>" : "") +
      '<em class="pv">' + esc(e.providerLabel) + "</em>" +
      '<button class="hb-mstar' + (fav ? " on" : "") + '" tabindex="-1">' + SVG_STAR + "</button></div>";
  };

  Picker.prototype.render = function () {
    var self = this, q = this.search.value, html = "", idx = 0;
    this.visible = [];

    function section(title, items, key, note) {
      if (!items.length) return;
      var col = key && self.collapsed[key] && !q;
      html += '<div class="hb-mhead"' + (key ? ' data-p="' + esc(key) + '"' : "") + ">" +
        (key ? '<i class="chev' + (col ? "" : " open") + '"></i>' : "") + esc(title) +
        (note ? ' <span>' + esc(note) + "</span>" : "") + '<span class="n">' + items.length + "</span></div>";
      if (col) return;
      items.forEach(function (e) { self.visible.push(e); html += self._row(e, idx++); });
    }

    if (q) {
      section("Hasil", search(this.list, q));
    } else {
      var favs = this.store.favs().map(function (id) { return self.byId[id]; }).filter(Boolean);
      var rec = this.store.recents().filter(function (id) { return favs.every(function (f) { return f.id !== id; }); })
        .map(function (id) { return self.byId[id]; }).filter(Boolean);
      section("Favorit", favs);
      section("Terakhir", rec);
      this.groups.forEach(function (g) { section(g.label, g.items, g.provider, g.note); });
    }

    if (!this.visible.length && !html) html = '<div class="hb-mempty">Tidak ada model yang cocok</div>';
    if (this.cursor >= this.visible.length) this.cursor = Math.max(0, this.visible.length - 1);
    this.listEl.innerHTML = html;
    this.countEl.textContent = this.list.length + " model";
  };

  global.HBModels = {
    parse: parse, prettify: prettify, entry: entry, catalog: catalog, flat: flat,
    search: search, detectFailure: detectFailure, Store: Store, Picker: Picker,
    DEFAULT_FAVS: DEFAULT_FAVS
  };
})(typeof window !== "undefined" ? window : global);
