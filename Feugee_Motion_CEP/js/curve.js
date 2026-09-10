/* =========================================================
   FEUGEE STUDIO - INTERACTIVE BEZIER EASING ENGINE
   Interactive Canvas graph + Cubic Bezier calculation
   ========================================================= */
(function (window) {
  "use strict";

  var canvas = document.getElementById("curveCanvas");
  var badge = document.getElementById("curveBadge");
  var inSlider = document.getElementById("inInfSlider");
  var outSlider = document.getElementById("outInfSlider");
  var inValText = document.getElementById("inInfVal");
  var outValText = document.getElementById("outInfVal");

  if (!canvas) return;

  var ctx = canvas.getContext("2d");
  var width = 0;
  var height = 0;
  var pad = 16;

  // Bezier Control points in normalized [0..1] range
  // cp1: out of keyframe 1 (Start handle)
  // cp2: into keyframe 2 (End handle)
  var cp1 = { x: 0.33, y: 0.0 };
  var cp2 = { x: 0.67, y: 1.0 };

  var draggingHandle = null;

  var PRESETS = {
    linear:     { cp1: { x: 0.0, y: 0.0 }, cp2: { x: 1.0, y: 1.0 }, inInf: 0,  outInf: 0 },
    easyease:   { cp1: { x: 0.33, y: 0.0 }, cp2: { x: 0.67, y: 1.0 }, inInf: 33, outInf: 33 },
    easein:     { cp1: { x: 0.42, y: 0.0 }, cp2: { x: 1.0,  y: 1.0 }, inInf: 0,  outInf: 50 },
    easeout:    { cp1: { x: 0.0,  y: 0.0 }, cp2: { x: 0.58, y: 1.0 }, inInf: 50, outInf: 0 },
    snap:       { cp1: { x: 0.75, y: 0.0 }, cp2: { x: 0.25, y: 1.0 }, inInf: 75, outInf: 75 },
    heavyin:    { cp1: { x: 0.90, y: 0.0 }, cp2: { x: 1.0,  y: 1.0 }, inInf: 0,  outInf: 90 },
    heavyout:   { cp1: { x: 0.0,  y: 0.0 }, cp2: { x: 0.10, y: 1.0 }, inInf: 90, outInf: 0 },
    exponential:{ cp1: { x: 0.16, y: 1.0 }, cp2: { x: 0.30, y: 1.0 }, inInf: 85, outInf: 85 }
  };

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    width = rect.width;
    height = rect.height;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function toScreen(norm) {
    var plotW = width - pad * 2;
    var plotH = height - pad * 2;
    return {
      x: pad + norm.x * plotW,
      y: (height - pad) - norm.y * plotH
    };
  }

  function fromScreen(screen) {
    var plotW = width - pad * 2;
    var plotH = height - pad * 2;
    var nx = (screen.x - pad) / plotW;
    var ny = ((height - pad) - screen.y) / plotH;
    return {
      x: Math.max(0, Math.min(1, nx)),
      y: Math.max(-0.3, Math.min(1.3, ny))
    };
  }

  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    var plotW = width - pad * 2;
    var plotH = height - pad * 2;

    var isLight = document.documentElement.getAttribute("data-theme") === "light";

    // Grid lines
    ctx.lineWidth = 1;
    ctx.strokeStyle = isLight ? "#e5e6eb" : "#1b1b22";
    for (var i = 0; i <= 4; i++) {
      var gx = pad + (plotW / 4) * i;
      var gy = pad + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(gx, pad);
      ctx.lineTo(gx, height - pad);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(pad, gy);
      ctx.lineTo(width - pad, gy);
      ctx.stroke();
    }

    // Diagonal reference
    ctx.strokeStyle = isLight ? "#d0d1db" : "#24242d";
    ctx.beginPath();
    ctx.moveTo(pad, height - pad);
    ctx.lineTo(width - pad, pad);
    ctx.stroke();

    var p0 = toScreen({ x: 0, y: 0 });
    var p1 = toScreen(cp1);
    var p2 = toScreen(cp2);
    var p3 = toScreen({ x: 1, y: 1 });

    // Handle lines
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(242, 99, 28, 0.45)"; // Orange handle
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();

    ctx.strokeStyle = "rgba(96, 180, 226, 0.45)"; // Blue handle
    ctx.beginPath();
    ctx.moveTo(p3.x, p3.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    // Bezier Curve
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = "#f2631c";
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    ctx.stroke();

    // End points
    drawPoint(p0, isLight ? "#9a9aa6" : "#7b7b88", 3);
    drawPoint(p3, isLight ? "#9a9aa6" : "#7b7b88", 3);

    // Control point handles
    drawHandle(p1, "#f2631c", draggingHandle === 1);
    drawHandle(p2, "#60b4e2", draggingHandle === 2);

    // Update badge & sliders
    var inInf = Math.round(cp1.x * 100);
    var outInf = Math.round((1 - cp2.x) * 100);
    if (badge) {
      badge.textContent = inInf + "% / " + outInf + "%";
    }
    if (inValText && !inSlider.matches(":active")) inValText.textContent = inInf + "%";
    if (outValText && !outSlider.matches(":active")) outValText.textContent = outInf + "%";
    if (inSlider && !inSlider.matches(":active")) inSlider.value = inInf;
    if (outSlider && !outSlider.matches(":active")) outSlider.value = outInf;
  }

  function drawPoint(p, color, radius) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawHandle(p, color, isActive) {
    ctx.fillStyle = isActive ? "#ffffff" : color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, isActive ? 6 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Pointer interaction
  function getPos(e) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  function dist(p1, p2) {
    var dx = p1.x - p2.x;
    var dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  canvas.addEventListener("mousedown", function (e) {
    var pos = getPos(e);
    var sp1 = toScreen(cp1);
    var sp2 = toScreen(cp2);

    if (dist(pos, sp1) < 14) {
      draggingHandle = 1;
    } else if (dist(pos, sp2) < 14) {
      draggingHandle = 2;
    } else {
      draggingHandle = null;
    }
    render();
  });

  window.addEventListener("mousemove", function (e) {
    if (!draggingHandle) return;
    var pos = getPos(e);
    var norm = fromScreen(pos);

    if (draggingHandle === 1) {
      cp1 = norm;
    } else if (draggingHandle === 2) {
      cp2 = norm;
    }
    render();
  });

  window.addEventListener("mouseup", function () {
    if (draggingHandle) {
      draggingHandle = null;
      render();
    }
  });

  // Slider inputs
  if (inSlider) {
    inSlider.addEventListener("input", function () {
      var val = parseFloat(inSlider.value) / 100;
      cp1.x = val;
      if (inValText) inValText.textContent = inSlider.value + "%";
      render();
    });
  }

  if (outSlider) {
    outSlider.addEventListener("input", function () {
      var val = parseFloat(outSlider.value) / 100;
      cp2.x = 1 - val;
      if (outValText) outValText.textContent = outSlider.value + "%";
      render();
    });
  }

  // Window resize
  window.addEventListener("resize", resize);
  setTimeout(resize, 50);

  // Export API
  window.FG_CURVE = {
    getCurve: function () {
      var inInf = Math.round(cp1.x * 100);
      var outInf = Math.round((1 - cp2.x) * 100);
      return {
        inInfluence: Math.max(0.1, Math.min(100, inInf)),
        outInfluence: Math.max(0.1, Math.min(100, outInf)),
        inSpeed: 0,
        outSpeed: 0,
        cp1: [cp1.x, cp1.y],
        cp2: [cp2.x, cp2.y]
      };
    },
    setPreset: function (presetKey) {
      var p = PRESETS[presetKey];
      if (!p) return;
      cp1 = { x: p.cp1.x, y: p.cp1.y };
      cp2 = { x: p.cp2.x, y: p.cp2.y };
      render();
    },
    render: render
  };

})(window);
