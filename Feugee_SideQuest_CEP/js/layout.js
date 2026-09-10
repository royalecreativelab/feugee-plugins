/* =========================================================
   FEUGEE SIDEQUEST  -  COLUMN LAYOUT
   SideQuest only. Load AFTER js/modes.js.

   One job: put the cards in columns and keep the column count matched to the
   panel width. The shared grid could not do this - it aligns rows, so SCALE
   POP (short) reserved the same row height as POSITION POP (tall) and left a
   dead rectangle underneath.

   Cards keep the exact reading order the numbers promise: card i goes to
   column i % n, so 01 / 02 / 03 sit left to right and 04 lands under 01 -
   the same arrangement the old grid produced. The only thing dropped is the
   grid's row alignment, and that is what the hole was.

   Shortest-column packing was tried first and rejected: it packs tighter, but
   at two columns it produced 01 / 03 / 04 down the left with 02 alone on the
   right. Tighter is not worth numbers that read out of order.

   Nothing here touches panel.css or modes.js. The compact view is left exactly
   as modes.js builds it.
   ========================================================= */
(function () {
  "use strict";

  var content = document.getElementById("content");
  if (!content) return;

  var cards = [];
  var found = content.querySelectorAll(".card");
  for (var i = 0; i < found.length; i++) cards.push(found[i]);
  if (!cards.length) return;

  var MIN_COL = 252;              // the width the shared grid used, so the feel matches
  var MAX_COLS = 4;
  var cols = [];
  var lastWidth = -1;

  function usableWidth() {
    var cs = getComputedStyle(content);
    var pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    return content.clientWidth - pad;
  }

  function gapPx() {
    var g = parseFloat(getComputedStyle(content).gap);
    return isNaN(g) ? 8 : g;
  }

  /* How lopsided row-major packing is at n columns: the fullest column minus
     the emptiest. Zero means every column holds the same number of cards. */
  function spread(n) {
    return Math.ceil(cards.length / n) - Math.floor(cards.length / n);
  }

  /* Four cards in three columns packs 2 / 1 / 1 - one full column beside two
     half-empty ones, which is exactly what the full view looked like. Dropping
     one column makes it 2 / 2 and the hole disappears, so prefer that. If
     stepping down does not even it out (five cards, say), keep the wider
     layout - narrower for nothing is worse. */
  function balance(n) {
    if (n < 2) return n;
    if (spread(n) === 0) return n;
    if (spread(n - 1) === 0) return n - 1;
    return n;
  }

  function colCount(w) {
    var gap = gapPx();
    var n = Math.floor((w + gap) / (MIN_COL + gap));
    if (n < 1) n = 1;
    if (n > MAX_COLS) n = MAX_COLS;
    if (n > cards.length) n = cards.length;   // never leave an empty column behind
    return balance(n);
  }

  function build(n) {
    while (cols.length > n) {
      var dead = cols.pop();
      if (dead.parentNode) dead.parentNode.removeChild(dead);
    }
    while (cols.length < n) {
      var el = document.createElement("div");
      el.className = "col";
      content.appendChild(el);
      cols.push(el);
    }
  }

  /* Row-major: card i -> column i % n. Reading order is preserved exactly, and
     because each column is an independent stack, a short card never reserves
     height for the tall one beside it. appendChild moves the card, so no card
     is ever detached and nothing inside it (focus, typed values) is lost. */
  function pack(n) {
    for (var k = 0; k < cards.length; k++) {
      cols[k % n].appendChild(cards[k]);
    }
  }

  function apply() {
    if (content.hidden) return;
    var w = usableWidth();
    if (w <= 0) return;
    if (w === lastWidth) return;
    lastWidth = w;
    content.classList.add("cols");
    var n = colCount(w);
    build(n);
    pack(n);
  }

  /* A width poll is what actually holds this together:
       - ResizeObserver callbacks ride the rendering lifecycle, so a panel that
         is hidden, occluded or docked away can go silent - it was measured
         firing ZERO times for a real 820 -> 300px change while the host window
         was not being painted;
       - a CEP panel resized by dragging its dock edge does not reliably raise
         a window resize event either.
     One clientWidth read every 350ms costs nothing and catches every case,
     including "was hidden, now shown". */
  var pending = null;
  function soon() {
    if (pending) clearTimeout(pending);
    pending = setTimeout(function () { pending = null; apply(); }, 60);
  }

  content.classList.add("cols");
  apply();

  setInterval(apply, 350);
  window.addEventListener("resize", soon);
  if (typeof ResizeObserver !== "undefined") {
    try { new ResizeObserver(soon).observe(content); } catch (e) {}
  }
  var modes = document.querySelector(".modes");
  if (modes) modes.addEventListener("click", soon);   // coming back from compact remeasures
})();
