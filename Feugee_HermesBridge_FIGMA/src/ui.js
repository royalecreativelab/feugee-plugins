/* Feugee Hermes Bridge (Figma) - UI iframe.
   The sandbox has no network, so this iframe is the link: it long-polls the
   local relay (127.0.0.1:3846) for jobs, hands them to the sandbox, and posts
   the results back. */
(function () {
  var RELAY = "http://localhost:3846"; // Figma manifests only accept host names, not IPs
  var CLIENT = "fig-" + Math.random().toString(36).slice(2, 10);
  var info = {};
  var calls = 0, connected = null, stopped = false;
  var waiting = {}; // job id -> true

  var $ = function (id) { return document.getElementById(id); };

  // follow Figma's own theme (themeColors:true puts figma-dark/figma-light on <html>)
  function syncTheme() {
    var light = document.documentElement.classList.contains("figma-light");
    document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
    document.body.setAttribute("data-theme", light ? "light" : "dark");
  }
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  syncTheme();

  function status(text, state) {
    $("status").textContent = text;
    $("led").className = "led" + (state === "ok" ? " ok" : state === "err" ? " err" : "");
  }
  function setConnected(on) {
    if (connected === on) return;
    connected = on;
    $("kvRelay").textContent = on ? "localhost:3846 · online" : "waiting for Hermes…";
    status(on ? "Connected · Hermes can edit this file" : "Relay offline · start any Hermes session (it starts the relay)", on ? "ok" : "err");
  }
  function renderInfo() {
    $("kvFile").textContent = info.fileName || "-";
    $("kvFile").title = info.fileKey ? "fileKey " + info.fileKey : "fileKey unavailable";
    $("kvPage").textContent = info.page || "-";
  }
  function logCall(tool, desc, ok, ms) {
    var ol = $("log");
    var empty = ol.querySelector(".hbf-empty"); if (empty) empty.remove();
    var li = document.createElement("li");
    if (!ok) li.className = "err";
    var b = document.createElement("b"); b.textContent = tool;
    var i = document.createElement("i"); i.textContent = (ok ? "" : "error · ") + ms + " ms";
    var s = document.createElement("span"); s.textContent = desc || "";
    li.appendChild(b); li.appendChild(i); if (desc) li.appendChild(s);
    ol.insertBefore(li, ol.firstChild);
    while (ol.children.length > 30) ol.removeChild(ol.lastChild);
    $("kvCalls").textContent = String(++calls);
  }

  function post(pathname, payload) {
    return fetch(RELAY + pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function runJob(job) {
    waiting[job.id] = { tool: job.tool, desc: job.args && job.args.description };
    status("Running " + job.tool + "…", "ok");
    parent.postMessage({ pluginMessage: { type: "job", job: job } }, "*");
  }

  window.onmessage = function (ev) {
    var m = ev.data && ev.data.pluginMessage;
    if (!m) return;
    if (m.type === "info") { info = m.info || {}; renderInfo(); return; }
    if (m.type === "closing") { stopped = true; post("/bye", { client: CLIENT }).catch(function () {}); return; }
    if (m.type === "result") {
      var w = waiting[m.id] || {}; delete waiting[m.id];
      logCall(m.tool, w.desc, m.ok, m.ms);
      status(m.ok ? "Connected · last call " + m.tool + " " + m.ms + " ms" : "Last call failed · " + String(m.error).split("\n")[0], m.ok ? "ok" : "err");
      var payload = Object.assign({}, m); delete payload.type;
      post("/result", payload).catch(function () { status("Could not deliver result to relay", "err"); });
    }
  };

  async function loop() {
    parent.postMessage({ pluginMessage: { type: "hello" } }, "*");
    await sleep(150);
    // quick health check so the status bar flips right away (the first /poll can hold for 25 s)
    try { var h = await fetch(RELAY + "/health"); setConnected(h.ok); } catch (e) { setConnected(false); }
    while (!stopped) {
      try {
        var r = await post("/poll", { client: CLIENT, info: info });
        if (!r.ok) throw new Error("HTTP " + r.status);
        var j = await r.json();
        setConnected(true);
        (j.jobs || []).forEach(runJob);
      } catch (e) {
        setConnected(false);
        await sleep(2000);
      }
    }
  }
  window.addEventListener("beforeunload", function () { try { navigator.sendBeacon(RELAY + "/bye", JSON.stringify({ client: CLIENT })); } catch (e) {} });
  loop();
})();
