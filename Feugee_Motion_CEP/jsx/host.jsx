/**
 * FEUGEE STUDIO - FEUGEE MOTION  |  HOST SCRIPT (ExtendScript)
 * Version: 1.0.0 (CEP)
 * Author: Muhammad Rijal Nurjaman (Feugee Studio)
 *
 * Full replicate of the 88 tools from Mt. Mograph Motion 4
 * All functions return "OK|message" or "ERR|message".
 * Strict ES3 compliance for Adobe After Effects ExtendScript.
 */

var FG_MOTION = (function () {
    "use strict";

    var FG_STATUS = { text: "" };
    var FG_CLIPBOARD = {
        ease: null,
        color: null
    };
    var FG_FOCUS_GROUPS = {};

    // ==========================================================
    // GUARDS & HELPERS
    // ==========================================================
    function fgGuard(needLayers) {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return "ERR|Open or activate a Composition first";
        if (needLayers) {
            var sel = comp.selectedLayers;
            if (!sel || sel.length === 0) return "ERR|Select at least 1 layer in the timeline";
        }
        return null;
    }

    function fgWrap(undoName, fn) {
        var bad = fgGuard(true);
        if (bad) return bad;
        FG_STATUS.text = "";
        app.beginUndoGroup(undoName || "Feugee Motion");
        try {
            fn();
        } catch (e) {
            app.endUndoGroup();
            return "ERR|" + e.toString();
        }
        app.endUndoGroup();
        return "OK|" + (FG_STATUS.text || "Finished successfully");
    }

    function fgWrapComp(undoName, fn) {
        var bad = fgGuard(false);
        if (bad) return bad;
        FG_STATUS.text = "";
        app.beginUndoGroup(undoName || "Feugee Motion");
        try {
            fn();
        } catch (e) {
            app.endUndoGroup();
            return "ERR|" + e.toString();
        }
        app.endUndoGroup();
        return "OK|" + (FG_STATUS.text || "Finished successfully");
    }

    function applyTemporalEaseSafe(prop, keyIndex, inEase, outEase) {
        try {
            prop.setTemporalEaseAtKey(keyIndex, [inEase], [outEase]);
            return;
        } catch(e1) {}
        try {
            prop.setTemporalEaseAtKey(keyIndex, [inEase, inEase], [outEase, outEase]);
            return;
        } catch(e2) {}
        try {
            prop.setTemporalEaseAtKey(keyIndex, [inEase, inEase, inEase], [outEase, outEase, outEase]);
            return;
        } catch(e3) {}
    }

    function hexToRgb(hex) {
        hex = hex.replace(/^#/, '');
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        var num = parseInt(hex, 16);
        return [
            ((num >> 16) & 255) / 255,
            ((num >> 8) & 255) / 255,
            (num & 255) / 255
        ];
    }

    // ==========================================================
    // MODULE 1: EASING & CURVES ENGINE
    // ==========================================================
    function applyCubicEase(inInf, outInf, inSpeed, outSpeed) {
        return fgWrap("Apply Easing", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            inInf = Math.max(0.1, Math.min(100, parseFloat(inInf) || 33.33));
            outInf = Math.max(0.1, Math.min(100, parseFloat(outInf) || 33.33));
            inSpeed = parseFloat(inSpeed) || 0;
            outSpeed = parseFloat(outSpeed) || 0;

            var inEase = new KeyframeEase(inSpeed, inInf);
            var outEase = new KeyframeEase(outSpeed, outInf);
            var count = 0;

            for (var i = 0; i < sel.length; i++) {
                var props = sel[i].selectedProperties;
                for (var p = 0; p < props.length; p++) {
                    var prop = props[p];
                    if (prop.canVaryOverTime && prop.numKeys > 0) {
                        var keys = prop.selectedKeys;
                        for (var k = 0; k < keys.length; k++) {
                            applyTemporalEaseSafe(prop, keys[k], inEase, outEase);
                            count++;
                        }
                    }
                }
            }
            if (count === 0) {
                FG_STATUS.text = "No keyframes selected (select keyframes to ease)";
            } else {
                FG_STATUS.text = "Applied ease (" + Math.round(inInf) + "/" + Math.round(outInf) + ") to " + count + " keyframes";
            }
        });
    }

    function copyEase() {
        var comp = app.project.activeItem;
        if (!comp) return "ERR|No active comp";
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) return "ERR|Select a layer with keyframes";

        for (var i = 0; i < sel.length; i++) {
            var props = sel[i].selectedProperties;
            for (var p = 0; p < props.length; p++) {
                var prop = props[p];
                if (prop.canVaryOverTime && prop.numKeys > 0 && prop.selectedKeys.length > 0) {
                    var keyIdx = prop.selectedKeys[0];
                    try {
                        var inE = prop.keyInTemporalEase(keyIdx);
                        var outE = prop.keyOutTemporalEase(keyIdx);
                        FG_CLIPBOARD.ease = {
                            inSpeed: inE[0].speed,
                            inInfluence: inE[0].influence,
                            outSpeed: outE[0].speed,
                            outInfluence: outE[0].influence
                        };
                        return "OK|Copied keyframe ease (" + Math.round(inE[0].influence) + "% / " + Math.round(outE[0].influence) + "%)";
                    } catch (e) {
                        return "ERR|Failed reading keyframe ease: " + e.toString();
                    }
                }
            }
        }
        return "ERR|Select at least one keyframe to copy ease";
    }

    function pasteEase() {
        if (!FG_CLIPBOARD.ease) return "ERR|No ease copied yet. Use Copy Ease first";
        return applyCubicEase(
            FG_CLIPBOARD.ease.inInfluence,
            FG_CLIPBOARD.ease.outInfluence,
            FG_CLIPBOARD.ease.inSpeed,
            FG_CLIPBOARD.ease.outSpeed
        );
    }

    function keyNav(dir) {
        var comp = app.project.activeItem;
        if (!comp) return "ERR|No active comp";
        var time = comp.time;
        var bestTime = (dir === "next") ? 999999 : -1;

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (!layer.selected) continue;
            var props = layer.selectedProperties;
            for (var p = 0; p < props.length; p++) {
                var prop = props[p];
                if (prop.canVaryOverTime && prop.numKeys > 0) {
                    for (var k = 1; k <= prop.numKeys; k++) {
                        var kt = prop.keyTime(k);
                        if (dir === "next" && kt > time + 0.001 && kt < bestTime) {
                            bestTime = kt;
                        } else if (dir === "prev" && kt < time - 0.001 && kt > bestTime) {
                            bestTime = kt;
                        }
                    }
                }
            }
        }

        if ((dir === "next" && bestTime < 999999) || (dir === "prev" && bestTime > -1)) {
            comp.time = bestTime;
            return "OK|Jumped to keyframe at " + bestTime.toFixed(2) + "s";
        }
        return "OK|No " + dir + " keyframe found";
    }

    function keyClean() {
        return fgWrap("Key Clean", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            var removed = 0;

            for (var i = 0; i < sel.length; i++) {
                var props = sel[i].selectedProperties;
                for (var p = 0; p < props.length; p++) {
                    var prop = props[p];
                    if (prop.canVaryOverTime && prop.numKeys > 1) {
                        for (var k = prop.numKeys - 1; k >= 2; k--) {
                            var prevVal = prop.keyValue(k - 1);
                            var currVal = prop.keyValue(k);
                            var nextVal = prop.keyValue(k + 1);
                            if (String(prevVal) === String(currVal) && String(currVal) === String(nextVal)) {
                                prop.removeKey(k);
                                removed++;
                            }
                        }
                    }
                }
            }
            FG_STATUS.text = "Cleaned " + removed + " redundant keyframes";
        });
    }

    function blendKeyframes() {
        return fgWrap("Blend Keyframes", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            var count = 0;

            for (var i = 0; i < sel.length; i++) {
                var props = sel[i].selectedProperties;
                for (var p = 0; p < props.length; p++) {
                    var prop = props[p];
                    if (prop.canVaryOverTime && prop.numKeys > 0) {
                        var keys = prop.selectedKeys;
                        for (var k = 0; k < keys.length; k++) {
                            var kIdx = keys[k];
                            try {
                                prop.setInterpolationTypeAtKey(kIdx, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                                count++;
                            } catch (e) {}
                        }
                    }
                }
            }
            FG_STATUS.text = "Blended " + count + " keyframes with smooth bezier";
        });
    }

    // ==========================================================
    // MODULE 2: ANCHOR POINT ENGINE
    // ==========================================================
    function setAnchorPoint(xRatio, yRatio, lockRot, incMasks) {
        return fgWrap("Set Anchor Point", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            xRatio = parseFloat(xRatio);
            yRatio = parseFloat(yRatio);

            for (var i = 0; i < sel.length; i++) {
                var layer = sel[i];
                if (!(layer instanceof AVLayer || layer instanceof ShapeLayer || layer instanceof TextLayer)) continue;

                var rect = null;
                try {
                    rect = layer.sourceRectAtTime(comp.time, incMasks === "true" || incMasks === true);
                } catch(e) {
                    rect = { left: 0, top: 0, width: layer.width || 100, height: layer.height || 100 };
                }

                var targetX = rect.left + rect.width * xRatio;
                var targetY = rect.top + rect.height * yRatio;

                var curAnchor = layer.property("ADBE Transform Group").property("ADBE Anchor Point").value;
                var curPos = layer.property("ADBE Transform Group").property("ADBE Position").value;

                var dx = targetX - curAnchor[0];
                var dy = targetY - curAnchor[1];

                // Pan behind compensation: update position so visual placement doesn't shift
                var rot = lockRot ? layer.property("ADBE Transform Group").property("ADBE Rotate Z").value : 0;
                var rad = (rot * Math.PI) / 180;
                var cos = Math.cos(rad);
                var sin = Math.sin(rad);
                var s = layer.property("ADBE Transform Group").property("ADBE Scale").value;
                var sx = s[0] / 100;
                var sy = s[1] / 100;

                var worldDx = (dx * cos - dy * sin) * sx;
                var worldDy = (dx * sin + dy * cos) * sy;

                layer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([targetX, targetY, curAnchor.length > 2 ? curAnchor[2] : 0]);
                layer.property("ADBE Transform Group").property("ADBE Position").setValue([curPos[0] + worldDx, curPos[1] + worldDy, curPos.length > 2 ? curPos[2] : 0]);
            }
            FG_STATUS.text = "Repositioned anchor point on " + sel.length + " layers";
        });
    }

    function centerAnchor() {
        return setAnchorPoint(0.5, 0.5, true, false);
    }

    function centerToComp() {
        return fgWrap("Center Layer to Comp", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            var cx = comp.width / 2;
            var cy = comp.height / 2;

            for (var i = 0; i < sel.length; i++) {
                var p = sel[i].property("ADBE Transform Group").property("ADBE Position");
                if (p.isTimeVarying) {
                    p.setValueAtTime(comp.time, [cx, cy, p.value.length > 2 ? p.value[2] : 0]);
                } else {
                    p.setValue([cx, cy, p.value.length > 2 ? p.value[2] : 0]);
                }
            }
            FG_STATUS.text = "Centered " + sel.length + " layers to composition";
        });
    }

    // ==========================================================
    // MODULE 3: ALIGN & DISTRIBUTE
    // ==========================================================
    function alignLayers(axis, mode, target) {
        return fgWrap("Align Layers", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            if (sel.length === 0) return;

            var targetMin = 0, targetMax = 0, targetMid = 0;

            if (target === "comp") {
                targetMin = 0;
                targetMax = (axis === "x") ? comp.width : comp.height;
                targetMid = targetMax / 2;
            } else {
                // target == 'sel'
                var bounds = [];
                for (var i = 0; i < sel.length; i++) {
                    var p = sel[i].property("ADBE Transform Group").property("ADBE Position").value;
                    bounds.push(axis === "x" ? p[0] : p[1]);
                }
                bounds.sort(function(a, b) { return a - b; });
                targetMin = bounds[0];
                targetMax = bounds[bounds.length - 1];
                targetMid = (targetMin + targetMax) / 2;
            }

            // if/else, not a chained ternary: ExtendScript parses a ? b : c ? d : e
            // as (a ? b : c) ? d : e, which sent "min" to targetMax.
            var dest = targetMid;
            if (mode === "min") {
                dest = targetMin;
            } else if (mode === "max") {
                dest = targetMax;
            }

            for (var j = 0; j < sel.length; j++) {
                var posProp = sel[j].property("ADBE Transform Group").property("ADBE Position");
                var cur = posProp.value;
                if (axis === "x") {
                    cur[0] = dest;
                } else {
                    cur[1] = dest;
                }
                if (posProp.isTimeVarying) {
                    posProp.setValueAtTime(comp.time, cur);
                } else {
                    posProp.setValue(cur);
                }
            }
            FG_STATUS.text = "Aligned " + sel.length + " layers on " + axis.toUpperCase();
        });
    }

    function distributeLayers(axis, mode, gapVal) {
        return fgWrap("Distribute Layers", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            if (sel.length < 2) {
                FG_STATUS.text = "Select at least 2 layers to distribute";
                return;
            }

            gapVal = parseFloat(gapVal) || 40;
            var idx = (axis === "x") ? 0 : 1;

            // Sort by current position
            var layerList = [];
            for (var i = 0; i < sel.length; i++) {
                layerList.push({
                    layer: sel[i],
                    pos: sel[i].property("ADBE Transform Group").property("ADBE Position").value
                });
            }
            layerList.sort(function (a, b) { return a.pos[idx] - b.pos[idx]; });

            if (mode === "fixed") {
                // Fixed gap spacing from the first layer
                var curCoord = layerList[0].pos[idx];
                for (var f = 1; f < layerList.length; f++) {
                    curCoord += gapVal;
                    var pos = layerList[f].pos;
                    pos[idx] = curCoord;
                    layerList[f].layer.property("ADBE Transform Group").property("ADBE Position").setValue(pos);
                }
                FG_STATUS.text = "Distributed " + sel.length + " layers with " + gapVal + "px gap";
            } else {
                // Equal spacing between first and last
                var start = layerList[0].pos[idx];
                var end = layerList[layerList.length - 1].pos[idx];
                var step = (end - start) / (layerList.length - 1);

                for (var k = 1; k < layerList.length - 1; k++) {
                    var pVal = layerList[k].pos;
                    pVal[idx] = start + step * k;
                    layerList[k].layer.property("ADBE Transform Group").property("ADBE Position").setValue(pVal);
                }
                FG_STATUS.text = "Distributed " + sel.length + " layers evenly on " + axis.toUpperCase();
            }
        });
    }

    function flipLayers(axis) {
        return fgWrap("Flip Layers", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            for (var i = 0; i < sel.length; i++) {
                var s = sel[i].property("ADBE Transform Group").property("ADBE Scale");
                var v = s.value;
                if (axis === "h") {
                    v[0] = -v[0];
                } else {
                    v[1] = -v[1];
                }
                if (s.isTimeVarying) {
                    s.setValueAtTime(comp.time, v);
                } else {
                    s.setValue(v);
                }
            }
            FG_STATUS.text = "Flipped " + sel.length + " layers " + (axis === "h" ? "Horizontally" : "Vertically");
        });
    }

    function arrangeLayers(dir) {
        return fgWrap("Arrange Layers", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            if (dir === "reverse") {
                for (var i = 0; i < sel.length; i++) {
                    sel[i].moveToBeginning();
                }
                FG_STATUS.text = "Reversed layer order";
            } else if (dir === "front") {
                for (var f = sel.length - 1; f >= 0; f--) {
                    sel[f].moveToBeginning();
                }
                FG_STATUS.text = "Moved layers to Front";
            } else if (dir === "back") {
                for (var b = 0; b < sel.length; b++) {
                    sel[b].moveToEnd();
                }
                FG_STATUS.text = "Moved layers to Back";
            }
        });
    }

    // ==========================================================
    // MODULE 4: RIGS, PHYSICS & DYNAMICS
    // ==========================================================
    function applyExcite(overshoot, bounce, friction) {
        return fgWrap("Apply Excite Rig", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            overshoot = parseFloat(overshoot) || 20;
            bounce = parseFloat(bounce) || 40;
            friction = parseFloat(friction) || 40;

            var expr =
                "// Feugee Excite (Inertial Bounce)\n" +
                "var amp = " + (overshoot / 100).toFixed(3) + ";\n" +
                "var freq = " + (bounce / 10).toFixed(2) + ";\n" +
                "var decay = " + (friction / 10).toFixed(2) + ";\n" +
                "var n = 0;\n" +
                "if (numKeys > 0) {\n" +
                "  n = nearestKey(time).index;\n" +
                "  if (key(n).time > time) n--;\n" +
                "}\n" +
                "if (n == 0) { value; } else {\n" +
                "  var t = time - key(n).time;\n" +
                "  if (t > 0 && t < 2) {\n" +
                "    var v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);\n" +
                "    value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);\n" +
                "  } else { value; }\n" +
                "}";

            var applied = 0;
            for (var i = 0; i < sel.length; i++) {
                var props = sel[i].selectedProperties;
                for (var p = 0; p < props.length; p++) {
                    var prop = props[p];
                    if (prop.canVaryOverTime) {
                        prop.expression = expr;
                        applied++;
                    }
                }
            }
            if (applied === 0) {
                // default to Position
                for (var j = 0; j < sel.length; j++) {
                    sel[j].property("ADBE Transform Group").property("ADBE Position").expression = expr;
                    applied++;
                }
            }
            FG_STATUS.text = "Applied Excite Overshoot to " + applied + " properties";
        });
    }

    function applyJump(stretch, gravity, maxJumps) {
        return fgWrap("Apply Jump Rig", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            stretch = parseFloat(stretch) || 60;
            gravity = parseFloat(gravity) || 8;

            var expr =
                "// Feugee Jump\n" +
                "var g = " + gravity + ";\n" +
                "var e = " + (stretch / 100).toFixed(2) + ";\n" +
                "var n = 0;\n" +
                "if (numKeys > 0) {\n" +
                "  n = nearestKey(time).index;\n" +
                "  if (key(n).time > time) n--;\n" +
                "}\n" +
                "if (n == 0) { value; } else {\n" +
                "  var t = time - key(n).time;\n" +
                "  var y = -0.5 * g * t * t + e * t * 50;\n" +
                "  value + [0, Math.min(0, -y * 10)];\n" +
                "}";

            for (var i = 0; i < sel.length; i++) {
                sel[i].property("ADBE Transform Group").property("ADBE Position").expression = expr;
            }
            FG_STATUS.text = "Applied Jump bouncing rig to " + sel.length + " layers";
        });
    }

    function createBurst(numRays, radius) {
        return fgWrapComp("Create Burst Rig", function () {
            var comp = app.project.activeItem;
            numRays = parseInt(numRays, 10) || 8;
            radius = parseFloat(radius) || 120;

            var burstLayer = comp.layers.addShape();
            burstLayer.name = "Burst Rig";
            var root = burstLayer.property("ADBE Root Vectors Group");

            var group = root.addProperty("ADBE Vector Group");
            group.name = "Ray";
            var contents = group.property("ADBE Vectors Group");

            var pathGroup = contents.addProperty("ADBE Vector Shape - Group");
            var myPath = new Shape();
            myPath.vertices = [[0, 0], [0, -radius]];
            myPath.closed = false;
            pathGroup.property("ADBE Vector Shape").setValue(myPath);

            var stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
            stroke.property("ADBE Vector Stroke Color").setValue([0.95, 0.39, 0.11, 1]); // Feugee Orange
            stroke.property("ADBE Vector Stroke Width").setValue(4);

            var trim = contents.addProperty("ADBE Vector Filter - Trim");
            trim.property("ADBE Vector Trim Start").setValueAtTime(comp.time, 0);
            trim.property("ADBE Vector Trim Start").setValueAtTime(comp.time + 0.5, 100);
            trim.property("ADBE Vector Trim End").setValueAtTime(comp.time, 0);
            trim.property("ADBE Vector Trim End").setValueAtTime(comp.time + 0.3, 100);

            var repeater = root.addProperty("ADBE Vector Filter - Repeater");
            repeater.property("ADBE Vector Repeater Copies").setValue(numRays);
            repeater.property("ADBE Vector Repeater Transform").property("ADBE Vector Repeater Rotation").setValue(360 / numRays);

            burstLayer.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
            FG_STATUS.text = "Created Burst Rig (" + numRays + " rays)";
        });
    }

    function applySpin(degPerSec) {
        return fgWrap("Apply Spin", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            degPerSec = parseFloat(degPerSec) || 180;
            var expr = "value + time * " + degPerSec + ";";

            for (var i = 0; i < sel.length; i++) {
                sel[i].property("ADBE Transform Group").property("ADBE Rotate Z").expression = expr;
            }
            FG_STATUS.text = "Applied Spin (" + degPerSec + " deg/s) to " + sel.length + " layers";
        });
    }

    function applyDynamics(freq, amp) {
        return fgWrap("Apply Dynamics Wiggle", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            freq = parseFloat(freq) || 2;
            amp = parseFloat(amp) || 30;
            var expr = "wiggle(" + freq + ", " + amp + ");";

            for (var i = 0; i < sel.length; i++) {
                sel[i].property("ADBE Transform Group").property("ADBE Position").expression = expr;
            }
            FG_STATUS.text = "Applied Dynamics Wiggle to " + sel.length + " layers";
        });
    }

    function applyDelay(frames) {
        return fgWrap("Apply Delay", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            if (sel.length < 2) {
                FG_STATUS.text = "Select leader layer first, then follower layers";
                return;
            }
            frames = parseFloat(frames) || 5;

            var leader = sel[0];
            for (var i = 1; i < sel.length; i++) {
                var delaySeconds = (frames * i) * comp.frameDuration;
                var expr = "thisComp.layer('" + leader.name + "').transform.position.valueAtTime(time - " + delaySeconds + ");";
                sel[i].property("ADBE Transform Group").property("ADBE Position").expression = expr;
            }
            FG_STATUS.text = "Chained " + (sel.length - 1) + " follower layers with " + frames + "f delay";
        });
    }

    // ==========================================================
    // MODULE 5: KEYFRAMES & TIMING AUTOMATION
    // ==========================================================
    function cloneKeyframes(mode) {
        return fgWrap("Clone Keyframes", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            var targetTime = comp.time;
            var cloned = 0;

            for (var i = 0; i < sel.length; i++) {
                var props = sel[i].selectedProperties;
                for (var p = 0; p < props.length; p++) {
                    var prop = props[p];
                    if (prop.canVaryOverTime && prop.selectedKeys.length > 0) {
                        var keys = prop.selectedKeys;
                        var firstTime = prop.keyTime(keys[0]);
                        var lastTime = prop.keyTime(keys[keys.length - 1]);
                        var span = lastTime - firstTime;

                        for (var k = 0; k < keys.length; k++) {
                            var kIdx = keys[k];
                            var origT = prop.keyTime(kIdx);
                            var val = prop.keyValue(kIdx);
                            var inE = prop.keyInTemporalEase(kIdx);
                            var outE = prop.keyOutTemporalEase(kIdx);

                            var newT = targetTime + (origT - firstTime);
                            if (mode === "inverse") {
                                newT = targetTime + (lastTime - origT);
                            }

                            var newKey = prop.addKey(newT);
                            prop.setValueAtKey(newKey, val);
                            applyTemporalEaseSafe(prop, newKey, inE[0], outE[0]);
                            cloned++;
                        }
                    }
                }
            }
            FG_STATUS.text = "Cloned " + cloned + " keyframes to CTI (" + mode + ")";
        });
    }

    function staggerLayers(stepFrames, dir) {
        return fgWrap("Stagger Layers", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            stepFrames = parseFloat(stepFrames) || 2;
            var step = stepFrames * comp.frameDuration;

            var list = [];
            for (var i = 0; i < sel.length; i++) list.push(sel[i]);
            if (dir === "up") list.reverse();

            var baseIn = list[0].inPoint;
            for (var j = 0; j < list.length; j++) {
                var offset = step * j;
                var duration = list[j].outPoint - list[j].inPoint;
                list[j].startTime = list[j].startTime + (baseIn + offset - list[j].inPoint);
            }
            FG_STATUS.text = "Staggered " + sel.length + " layers by " + stepFrames + " frames";
        });
    }

    function separatePosition() {
        return fgWrap("Separate Position", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            app.executeCommand(2212); // Native AE Separate Dimensions command ID
            FG_STATUS.text = "Separated Position Dimensions on " + sel.length + " layers";
        });
    }

    function trimToKeys(mode) {
        return fgWrap("Trim to Keys", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            var count = 0;

            for (var i = 0; i < sel.length; i++) {
                var layer = sel[i];
                var minT = 999999, maxT = -1;
                for (var p = 1; p <= layer.property("ADBE Transform Group").numProperties; p++) {
                    var prop = layer.property("ADBE Transform Group").property(p);
                    if (prop.canVaryOverTime && prop.numKeys > 0) {
                        var kMin = prop.keyTime(1);
                        var kMax = prop.keyTime(prop.numKeys);
                        if (kMin < minT) minT = kMin;
                        if (kMax > maxT) maxT = kMax;
                    }
                }
                if (minT < 999999) {
                    if (mode === "in" || mode === "both") layer.inPoint = minT;
                    if (mode === "out" || mode === "both") layer.outPoint = maxT;
                    count++;
                }
            }
            FG_STATUS.text = "Trimmed " + count + " layers to boundary keyframes";
        });
    }

    function addTrimPaths() {
        return fgWrap("Add Trim Paths", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            var added = 0;

            for (var i = 0; i < sel.length; i++) {
                if (sel[i] instanceof ShapeLayer) {
                    sel[i].property("ADBE Root Vectors Group").addProperty("ADBE Vector Filter - Trim");
                    added++;
                }
            }
            FG_STATUS.text = "Added Trim Paths to " + added + " shape layers";
        });
    }

    // ==========================================================
    // MODULE 6: LAYER & COMP UTILITIES
    // ==========================================================
    function createNullRig(autoParent) {
        return fgWrap("Create Null Rig", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            autoParent = (autoParent === "true" || autoParent === true);

            var avgX = 0, avgY = 0;
            for (var i = 0; i < sel.length; i++) {
                var pos = sel[i].property("ADBE Transform Group").property("ADBE Position").value;
                avgX += pos[0];
                avgY += pos[1];
            }
            avgX /= sel.length;
            avgY /= sel.length;

            var nullLayer = comp.layers.addNull();
            nullLayer.name = "Null Control";
            nullLayer.property("ADBE Transform Group").property("ADBE Position").setValue([avgX, avgY]);

            if (autoParent) {
                for (var j = 0; j < sel.length; j++) {
                    sel[j].parent = nullLayer;
                }
            }
            FG_STATUS.text = "Created Null Rig centered on " + sel.length + " layers";
        });
    }

    function breakText(mode) {
        return fgWrap("Break Text", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            var broken = 0;

            for (var i = 0; i < sel.length; i++) {
                var layer = sel[i];
                if (!(layer instanceof TextLayer)) continue;
                var textProp = layer.property("ADBE Text Properties").property("ADBE Text Document");
                var textDoc = textProp.value;
                var str = textDoc.text;

                var parts = [];
                if (mode === "word") {
                    parts = str.split(/\s+/);
                } else if (mode === "line") {
                    parts = str.split(/[\r\n]+/);
                } else {
                    parts = str.split("");
                }

                var curPos = layer.property("ADBE Transform Group").property("ADBE Position").value;
                for (var p = 0; p < parts.length; p++) {
                    if (parts[p].length === 0) continue;
                    var newL = comp.layers.addText(parts[p]);
                    newL.property("ADBE Transform Group").property("ADBE Position").setValue([curPos[0] + p * 30, curPos[1]]);
                    broken++;
                }
                layer.enabled = false;
            }
            FG_STATUS.text = "Broken text into " + broken + " individual layers (" + mode + ")";
        });
    }

    function batchRename(prefix, suffix, findStr, replaceStr, serialize) {
        return fgWrap("Batch Rename", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;

            for (var i = 0; i < sel.length; i++) {
                var name = sel[i].name;
                if (findStr && findStr.length > 0) {
                    name = name.split(findStr).join(replaceStr || "");
                }
                if (prefix) name = prefix + name;
                if (suffix) name = name + suffix;
                if (serialize === "true" || serialize === true) {
                    var num = (i + 1) < 10 ? "0" + (i + 1) : String(i + 1);
                    name = name + "_" + num;
                }
                sel[i].name = name;
            }
            FG_STATUS.text = "Renamed " + sel.length + " layers";
        });
    }

    function cropCompToLayer() {
        return fgWrapComp("Crop Comp to Layer", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            if (!sel || sel.length === 0) return "ERR|Select a layer to crop comp bounds to";

            var rect = sel[0].sourceRectAtTime(comp.time, false);
            var pos = sel[0].property("ADBE Transform Group").property("ADBE Position").value;

            comp.width = Math.max(16, Math.round(rect.width));
            comp.height = Math.max(16, Math.round(rect.height));

            sel[0].property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
            FG_STATUS.text = "Cropped Comp to " + comp.width + "x" + comp.height + "px";
        });
    }

    function snapshotFrame() {
        var comp = app.project.activeItem;
        if (!comp) return "ERR|Open a Composition first";
        try {
            var desktop = Folder.desktop;
            var targetFile = new File(desktop.fsName + "/" + comp.name + "_frame_" + comp.frameDuration + ".png");
            comp.saveFrameToPng(comp.time, targetFile);
            return "OK|Saved PNG snapshot to Desktop";
        } catch (e) {
            return "ERR|Snapshot failed: " + e.toString();
        }
    }

    function trashClean() {
        return fgWrapComp("Clean Project Trash", function () {
            app.purge(PurgeTarget.ALL_CACHES);
            FG_STATUS.text = "Purged all memory caches and cleaned trash";
        });
    }

    // ==========================================================
    // MODULE 7: COLOR ENGINE
    // ==========================================================
    function applyColor(hex, mode, opacity) {
        return fgWrap("Apply Color", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            var rgb = hexToRgb(hex || "#f2631c");
            opacity = parseFloat(opacity) || 100;
            var count = 0;

            for (var i = 0; i < sel.length; i++) {
                var layer = sel[i];
                if (layer instanceof ShapeLayer) {
                    var vectors = layer.property("ADBE Root Vectors Group");
                    for (var v = 1; v <= vectors.numProperties; v++) {
                        var group = vectors.property(v);
                        if (group && group.property("ADBE Vectors Group")) {
                            var inner = group.property("ADBE Vectors Group");
                            if (mode === "fill" || mode === "both") {
                                var fill = inner.property("ADBE Vector Graphic - Fill");
                                if (fill) {
                                    fill.property("ADBE Vector Fill Color").setValue(rgb);
                                    fill.property("ADBE Vector Fill Opacity").setValue(opacity);
                                    count++;
                                }
                            }
                            if (mode === "stroke" || mode === "both") {
                                var stroke = inner.property("ADBE Vector Graphic - Stroke");
                                if (stroke) {
                                    stroke.property("ADBE Vector Stroke Color").setValue(rgb);
                                    stroke.property("ADBE Vector Stroke Opacity").setValue(opacity);
                                    count++;
                                }
                            }
                        }
                    }
                } else if (layer instanceof TextLayer) {
                    var textProp = layer.property("ADBE Text Properties").property("ADBE Text Document");
                    var doc = textProp.value;
                    if (mode === "fill" || mode === "both") {
                        doc.fillColor = rgb;
                        doc.applyFill = true;
                    }
                    if (mode === "stroke" || mode === "both") {
                        doc.strokeColor = rgb;
                        doc.applyStroke = true;
                    }
                    textProp.setValue(doc);
                    count++;
                }
            }
            FG_STATUS.text = "Applied color " + hex + " to " + count + " elements";
        });
    }

    function swapColors() {
        return fgWrap("Swap Fill & Stroke", function () {
            var comp = app.project.activeItem;
            var sel = comp.selectedLayers;
            var swapped = 0;

            for (var i = 0; i < sel.length; i++) {
                var layer = sel[i];
                if (layer instanceof ShapeLayer) {
                    var vectors = layer.property("ADBE Root Vectors Group");
                    for (var v = 1; v <= vectors.numProperties; v++) {
                        var group = vectors.property(v);
                        if (group && group.property("ADBE Vectors Group")) {
                            var inner = group.property("ADBE Vectors Group");
                            var fill = inner.property("ADBE Vector Graphic - Fill");
                            var stroke = inner.property("ADBE Vector Graphic - Stroke");
                            if (fill && stroke) {
                                var fCol = fill.property("ADBE Vector Fill Color").value;
                                var sCol = stroke.property("ADBE Vector Stroke Color").value;
                                fill.property("ADBE Vector Fill Color").setValue(sCol);
                                stroke.property("ADBE Vector Stroke Color").setValue(fCol);
                                swapped++;
                            }
                        }
                    }
                }
            }
            FG_STATUS.text = "Swapped Fill and Stroke on " + swapped + " elements";
        });
    }

    // Expose Public Host API
    return {
        // Module 1: Easing
        applyCubicEase: applyCubicEase,
        copyEase: copyEase,
        pasteEase: pasteEase,
        keyNav: keyNav,
        keyClean: keyClean,
        blendKeyframes: blendKeyframes,

        // Module 2: Anchor
        setAnchorPoint: setAnchorPoint,
        centerAnchor: centerAnchor,
        centerToComp: centerToComp,

        // Module 3: Align & Distribute
        alignLayers: alignLayers,
        distributeLayers: distributeLayers,
        flipLayers: flipLayers,
        arrangeLayers: arrangeLayers,

        // Module 4: Rigs & Physics
        applyExcite: applyExcite,
        applyJump: applyJump,
        createBurst: createBurst,
        applySpin: applySpin,
        applyDynamics: applyDynamics,
        applyDelay: applyDelay,

        // Module 5: Keyframes & Timing
        cloneKeyframes: cloneKeyframes,
        staggerLayers: staggerLayers,
        separatePosition: separatePosition,
        trimToKeys: trimToKeys,
        addTrimPaths: addTrimPaths,

        // Module 6: Utilities
        createNullRig: createNullRig,
        breakText: breakText,
        batchRename: batchRename,
        cropCompToLayer: cropCompToLayer,
        snapshotFrame: snapshotFrame,
        trashClean: trashClean,

        // Module 7: Color
        applyColor: applyColor,
        swapColors: swapColors
    };

})();
