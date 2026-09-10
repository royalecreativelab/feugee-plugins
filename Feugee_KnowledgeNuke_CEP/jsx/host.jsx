/**
 * FEUGEE STUDIO - KNOWLEDGE NUKE  |  HOST SCRIPT (ExtendScript)
 * Version: 3.1 (CEP)
 * Author: Muhammad Rijal Nurjaman (Feugee Studio)
 *
 * This file has NO UI. The UI lives in index.html (CEP panel).
 * The "CORE MOTION" block below carries the v1.3.1 logic unchanged; only the
 * user-facing strings and the direction vocabulary were translated to English.
 *
 * The panel calls the fg*() entry points through evalScript() and receives
 * a string of the form "OK|message" or "ERR|message".
 */

/* ---------------------------------------------------------------------------
   NAMESPACE - do not remove.

   Every CEP extension loaded in one After Effects instance shares ONE global
   ExtendScript scope. Two plugins declaring `fgWrap` overwrite each other and
   the panel that loaded first silently calls the other plugin's function.
   That is exactly what happened between Knowledge Nuke and Feugelign.

   So the whole host lives inside this IIFE and exposes a single global object.
   The body below is left at its original indentation on purpose, so it stays
   diffable against earlier versions.
   --------------------------------------------------------------------------- */

var FG_KN = (function () {

// Stand-in for the old ScriptUI statictext: core functions still write to .text.
var FG_STATUS = { text: "" };

// ==========================================
// GUARD - runs before the core, so a bad selection never opens a modal alert
// ==========================================
function fgGuard(needLayers) {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) return "ERR|Open or activate a Composition first";
    if (needLayers) {
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) return "ERR|Select at least 1 layer in the timeline";
    }
    return null;
}

function fgWrap(fn) {
    var bad = fgGuard(true);
    if (bad) return bad;
    FG_STATUS.text = "";
    try {
        fn();
    } catch (e) {
        return "ERR|" + e.toString();
    }
    if (!FG_STATUS.text) return "OK|Done";
    return "OK|" + String(FG_STATUS.text).replace(/^[✓\s]+/, "");
}

// ==========================================================
// CORE MOTION - v1.3.1 logic, unchanged
// ==========================================================
// ==========================================
// UTILITY / CORE MOTION HELPERS
// ==========================================
function getActiveComp() {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {
        alert("Please open or activate a Composition first.");
        return null;
    }
    return comp;
}

function getSelectedLayers(comp) {
    if (!comp) return [];
    var layers = comp.selectedLayers;
    if (!layers || layers.length === 0) {
        alert("Please select at least 1 layer in the timeline.");
        return [];
    }
    return layers;
}

// Deep search property in effects
function findEffectProp(effect, candidates) {
    if (!effect) return null;
    for (var i = 0; i < candidates.length; i++) {
        try {
            var p = effect.property(candidates[i]);
            if (p) return p;
        } catch(e) {}
    }
    if (effect.numProperties) {
        for (var j = 1; j <= effect.numProperties; j++) {
            try {
                var sub = effect.property(j);
                for (var k = 0; k < candidates.length; k++) {
                    if (sub.name == candidates[k] || sub.matchName == candidates[k]) return sub;
                }
                if (sub.numProperties) {
                    for (var m = 1; m <= sub.numProperties; m++) {
                        var leaf = sub.property(m);
                        for (var n = 0; n < candidates.length; n++) {
                            if (leaf.name == candidates[n] || leaf.matchName == candidates[n]) return leaf;
                        }
                    }
                }
            } catch(e2) {}
        }
    }
    return null;
}

// Bulletproof Temporal Ease applicator (handles Spatial 1-scalar and multi-dim)
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

// Bulletproof Spatial Tangents applicator (auto adapts to 2D or 3D)
function applySpatialTangentsSafe(prop, keyIndex, inTan, outTan) {
    var targetDims = 2;
    try {
        var val = prop.keyValue(keyIndex);
        if (val instanceof Array) targetDims = val.length;
    } catch(eVal) {
        try {
            if (prop.value instanceof Array) targetDims = prop.value.length;
        } catch(eVal2) {}
    }

    function formatTan(t, dims) {
        var x = (t && t.length > 0) ? t[0] : 0;
        var y = (t && t.length > 1) ? t[1] : 0;
        var z = (t && t.length > 2) ? t[2] : 0;
        if (dims === 3) return [x, y, z];
        return [x, y];
    }

    // Try detected dimensions first
    try {
        prop.setSpatialTangentsAtKey(keyIndex, formatTan(inTan, targetDims), formatTan(outTan, targetDims));
        return;
    } catch(e1) {}

    // Fallback: Try 3 elements
    try {
        prop.setSpatialTangentsAtKey(keyIndex, formatTan(inTan, 3), formatTan(outTan, 3));
        return;
    } catch(e2) {}

    // Fallback: Try 2 elements
    try {
        prop.setSpatialTangentsAtKey(keyIndex, formatTan(inTan, 2), formatTan(outTan, 2));
        return;
    } catch(e3) {}
}

// ==========================================
// 1. KEYFRAME POP (POSITION 12F / 50PX / EASE 100,0)
// ==========================================
function applyPositionPop(direction, distPx, durationFrames, statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee Pop: " + direction);
    var count = 0;

    try {
        var easeOut = new KeyframeEase(0, 0.1);
        var easeIn  = new KeyframeEase(0, 100);

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var transformGroup = layer.transform;
            if (!transformGroup) continue;

            var posProp = transformGroup.position;
            if (!posProp) continue;

            var t1 = layer.inPoint;
            var t2 = layer.inPoint + (durationFrames * comp.frameDuration);

            if (posProp.dimensionsSeparated) {
                var xProp = transformGroup.xPosition;
                var yProp = transformGroup.yPosition;

                if (direction === "left" || direction === "right") {
                    var origX = xProp.valueAtTime(t2, false);
                    var startX = (direction === "left") ? (origX - distPx) : (origX + distPx);
                    xProp.setValueAtTime(t1, startX);
                    xProp.setValueAtTime(t2, origX);

                    var k1 = xProp.nearestKeyIndex(t1);
                    var k2 = xProp.nearestKeyIndex(t2);
                    applyTemporalEaseSafe(xProp, k1, easeOut, easeOut);
                    applyTemporalEaseSafe(xProp, k2, easeIn, easeIn);
                } else if (direction === "top" || direction === "bottom") {
                    var origY = yProp.valueAtTime(t2, false);
                    var startY = (direction === "top") ? (origY - distPx) : (origY + distPx);
                    yProp.setValueAtTime(t1, startY);
                    yProp.setValueAtTime(t2, origY);

                    var ky1 = yProp.nearestKeyIndex(t1);
                    var ky2 = yProp.nearestKeyIndex(t2);
                    applyTemporalEaseSafe(yProp, ky1, easeOut, easeOut);
                    applyTemporalEaseSafe(yProp, ky2, easeIn, easeIn);
                }
            } else {
                var origPos = posProp.valueAtTime(t2, false);
                var startPos = [origPos[0], origPos[1]];
                var is3D = (origPos instanceof Array && origPos.length === 3);
                if (is3D) startPos.push(origPos[2]);

                if (direction === "left") startPos[0] -= distPx;
                else if (direction === "right") startPos[0] += distPx;
                else if (direction === "top") startPos[1] -= distPx;
                else if (direction === "bottom") startPos[1] += distPx;

                posProp.setValueAtTime(t1, startPos);
                posProp.setValueAtTime(t2, origPos);

                var keyIdx1 = posProp.nearestKeyIndex(t1);
                var keyIdx2 = posProp.nearestKeyIndex(t2);

                posProp.setSpatialAutoBezierAtKey(keyIdx1, false);
                posProp.setSpatialAutoBezierAtKey(keyIdx2, false);
                posProp.setSpatialContinuousAtKey(keyIdx1, false);
                posProp.setSpatialContinuousAtKey(keyIdx2, false);

                applySpatialTangentsSafe(posProp, keyIdx1, [0, 0, 0], [0, 0, 0]);
                applySpatialTangentsSafe(posProp, keyIdx2, [0, 0, 0], [0, 0, 0]);

                applyTemporalEaseSafe(posProp, keyIdx1, easeOut, easeOut);
                applyTemporalEaseSafe(posProp, keyIdx2, easeIn, easeIn);
            }
            count++;
        }
        if (statusLabel) statusLabel.text = "Pop " + direction.toUpperCase() + " applied to " + count + " layer(s) (" + durationFrames + "f)";
    } catch(e) {
        alert("Error applyPositionPop: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// 2. TRANSISI CURVE (IN/OUT FRAME - 2s / EASE 80,80)
// ==========================================
function applyCurveTransition(isInFrame, durSec, statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee Curve " + (isInFrame ? "In-Frame" : "Out-Frame"));
    var count = 0;

    try {
        var compW = comp.width;
        var compH = comp.height;
        var ease80 = new KeyframeEase(0, 80);

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var tf = layer.transform;
            if (!tf || !tf.position) continue;

            // Ensure non-separated dimensions to enable 2D/3D spatial bezier curves
            if (tf.position.dimensionsSeparated) {
                tf.position.dimensionsSeparated = false;
            }

            var origPos = tf.position.value;
            var dims = (origPos instanceof Array) ? origPos.length : 2;
            var is3D = (dims === 3 || layer.threeDLayer);

            var destX = origPos[0];
            var destY = origPos[1];
            var zVal = (dims > 2) ? origPos[2] : 0;

            // Dynamic sector distribution with randomized angle variation
            var sector = (i + Math.floor(Math.random() * 4)) % 4;
            var pad = 280 + (Math.random() * 260); // 280-540px outside comp frame
            var startX = 0;
            var startY = 0;

            if (sector === 0) { // Top
                startX = Math.random() * (compW + 240) - 120;
                startY = -pad;
            } else if (sector === 1) { // Right
                startX = compW + pad;
                startY = Math.random() * (compH + 240) - 120;
            } else if (sector === 2) { // Bottom
                startX = Math.random() * (compW + 240) - 120;
                startY = compH + pad;
            } else { // Left
                startX = -pad;
                startY = Math.random() * (compH + 240) - 120;
            }

            var outPos = is3D ? [startX, startY, zVal] : [startX, startY];
            var inPos  = is3D ? [destX, destY, zVal] : [destX, destY];

            // Tangent vector calculation for curved bezier path
            var dx = destX - startX;
            var dy = destY - startY;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1) dist = 1;
            var ux = dx / dist;
            var uy = dy / dist;
            var nx = -uy;
            var ny = ux;

            // Randomized arc bend direction (clockwise or counter-clockwise)
            var curveSign = (Math.random() > 0.5) ? 1 : -1;
            var arcFactor = 0.28 + (Math.random() * 0.18); // 0.28 to 0.46 arc depth
            var tanLen = dist * arcFactor;

            var outTan1 = [
                ux * dist * 0.25 + nx * tanLen * 0.5 * curveSign,
                uy * dist * 0.25 + ny * tanLen * 0.5 * curveSign
            ];
            var inTan2 = [
                -ux * dist * 0.25 + nx * tanLen * curveSign,
                -uy * dist * 0.25 + ny * tanLen * curveSign
            ];

            if (isInFrame) {
                // Fly In: outside frame -> resting position
                var t1 = layer.inPoint;
                var t2 = layer.inPoint + durSec;

                tf.position.setValueAtTime(t1, outPos);
                tf.position.setValueAtTime(t2, inPos);

                var k1 = tf.position.nearestKeyIndex(t1);
                var k2 = tf.position.nearestKeyIndex(t2);

                tf.position.setSpatialAutoBezierAtKey(k1, false);
                tf.position.setSpatialAutoBezierAtKey(k2, false);
                tf.position.setSpatialContinuousAtKey(k1, false);
                tf.position.setSpatialContinuousAtKey(k2, false);

                applySpatialTangentsSafe(tf.position, k1, [0, 0, 0], outTan1);
                applySpatialTangentsSafe(tf.position, k2, inTan2, [0, 0, 0]);

                applyTemporalEaseSafe(tf.position, k1, ease80, ease80);
                applyTemporalEaseSafe(tf.position, k2, ease80, ease80);
            } else {
                // Fly Out: resting position -> outside frame
                var to1 = layer.outPoint - durSec;
                var to2 = layer.outPoint;

                tf.position.setValueAtTime(to1, inPos);
                tf.position.setValueAtTime(to2, outPos);

                var ko1 = tf.position.nearestKeyIndex(to1);
                var ko2 = tf.position.nearestKeyIndex(to2);

                tf.position.setSpatialAutoBezierAtKey(ko1, false);
                tf.position.setSpatialAutoBezierAtKey(ko2, false);
                tf.position.setSpatialContinuousAtKey(ko1, false);
                tf.position.setSpatialContinuousAtKey(ko2, false);

                applySpatialTangentsSafe(tf.position, ko1, [0, 0, 0], [-inTan2[0], -inTan2[1], 0]);
                applySpatialTangentsSafe(tf.position, ko2, [-outTan1[0], -outTan1[1], 0], [0, 0, 0]);

                applyTemporalEaseSafe(tf.position, ko1, ease80, ease80);
                applyTemporalEaseSafe(tf.position, ko2, ease80, ease80);
            }
            count++;
        }
        if (statusLabel) statusLabel.text = "Curve " + (isInFrame ? "IN" : "OUT") + " (" + durSec + "s, ease 80/80) applied to " + count + " layer(s)";
    } catch(e) {
        alert("Error applyCurveTransition: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// 3. OVERLAP / STAGGER ASSETS
// ==========================================
function applyOverlap(directionDown, stepFrames, statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee Overlap Assets");
    try {
        var sorted = [];
        for (var i = 0; i < layers.length; i++) sorted.push(layers[i]);
        sorted.sort(function(a, b) { return a.index - b.index; });

        if (!directionDown) {
            sorted.reverse();
        }

        var baseStartTime = sorted[0].startTime;
        var offsetSec = stepFrames * comp.frameDuration;

        for (var j = 0; j < sorted.length; j++) {
            sorted[j].startTime = baseStartTime + (j * offsetSec);
        }

        if (statusLabel) statusLabel.text = "Overlap " + stepFrames + "f applied to " + sorted.length + " layer(s)";
    } catch(e) {
        alert("Error applyOverlap: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// 4. STOP-MOTION WIGGLE EXPRESSIONS
// ==========================================
var WIGGLE_POS_CODE = "posterizeTime(2);\nwiggle(10, 10);";
var WIGGLE_ROT_CODE = "posterizeTime(2);\nwiggle(10, 2);";

function applyWiggleExpressions(applyPos, applyRot, statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee Wiggle Expressions");
    var count = 0;
    try {
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var tf = layer.transform;
            if (!tf) continue;

            if (applyPos && tf.position) {
                if (tf.position.dimensionsSeparated) {
                    if (tf.xPosition) {
                        tf.xPosition.expression = "posterizeTime(2);\nwiggle(10, 10)[0];";
                        tf.xPosition.expressionEnabled = true;
                    }
                    if (tf.yPosition) {
                        tf.yPosition.expression = "posterizeTime(2);\nwiggle(10, 10)[1];";
                        tf.yPosition.expressionEnabled = true;
                    }
                } else {
                    tf.position.expression = WIGGLE_POS_CODE;
                    tf.position.expressionEnabled = true;
                }
            }

            if (applyRot) {
                if (layer.threeDLayer && tf.zRotation) {
                    tf.zRotation.expression = WIGGLE_ROT_CODE;
                    tf.zRotation.expressionEnabled = true;
                } else if (tf.rotation) {
                    tf.rotation.expression = WIGGLE_ROT_CODE;
                    tf.rotation.expressionEnabled = true;
                }
            }
            count++;
        }
        if (statusLabel) statusLabel.text = "Wiggle expressions applied to " + count + " layer(s)";
    } catch(e) {
        alert("Error applyWiggleExpressions: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

function removeWiggleExpressions(statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee Remove Wiggle");
    try {
        for (var i = 0; i < layers.length; i++) {
            var tf = layers[i].transform;
            if (!tf) continue;
            if (tf.position) {
                if (tf.position.dimensionsSeparated) {
                    if (tf.xPosition) tf.xPosition.expression = "";
                    if (tf.yPosition) tf.yPosition.expression = "";
                } else {
                    tf.position.expression = "";
                }
            }
            if (tf.rotation) tf.rotation.expression = "";
            if (tf.zRotation) tf.zRotation.expression = "";
        }
        if (statusLabel) statusLabel.text = "Wiggle expressions removed from the selected layers";
    } catch(e) {
        alert("Error removeWiggleExpressions: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// 5. TURBULENT DISPLACE PRESET
// ==========================================
function applyTurbulentDisplace(statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee Turbulent Displace Preset");
    var count = 0;
    try {
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var fxGroup = layer.property("ADBE Effect Parade");
            if (!fxGroup) continue;

            var fx = fxGroup.addProperty("ADBE Turbulent Displace");
            fx.name = "Turbulent Displace (Stop Motion)";

            var amountProp = findEffectProp(fx, ["Amount", "ADBE Turbulent Displace-0002"]);
            if (amountProp) amountProp.setValue(45.0);

            var sizeProp = findEffectProp(fx, ["Size", "ADBE Turbulent Displace-0003"]);
            if (sizeProp) sizeProp.setValue(227.0);

            var compProp = findEffectProp(fx, ["Complexity", "ADBE Turbulent Displace-0005"]);
            if (compProp) compProp.setValue(1.0);

            var evoProp = findEffectProp(fx, ["Evolution", "ADBE Turbulent Displace-0006"]);
            if (evoProp) {
                evoProp.expression = "posterizeTime(3);\ntime * 100;";
                evoProp.expressionEnabled = true;
            }

            var pinProp = findEffectProp(fx, ["Pinning", "ADBE Turbulent Displace-0008"]);
            if (pinProp) {
                try { pinProp.setValue(2); } catch(ePin) {}
            }

            var aaProp = findEffectProp(fx, ["Antialiasing for Best Qual", "ADBE Turbulent Displace-0010"]);
            if (aaProp) {
                try { aaProp.setValue(1); } catch(eAa) {}
            }

            count++;
        }
        if (statusLabel) statusLabel.text = "Turbulent Displace preset applied to " + count + " layer(s)";
    } catch(e) {
        alert("Error applyTurbulentDisplace: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

function removeTurbulentDisplace(statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee Remove Turbulent Displace");
    try {
        var count = 0;
        for (var i = 0; i < layers.length; i++) {
            var fxGroup = layers[i].property("ADBE Effect Parade");
            if (!fxGroup) continue;
            for (var j = fxGroup.numProperties; j >= 1; j--) {
                var fx = fxGroup.property(j);
                if (fx.matchName === "ADBE Turbulent Displace" || fx.name.indexOf("Turbulent Displace") !== -1) {
                    fx.remove();
                    count++;
                }
            }
        }
        if (statusLabel) statusLabel.text = "Removed " + count + " Turbulent Displace effect(s)";
    } catch(e) {
        alert("Error removeTurbulentDisplace: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// 6. AUTO NULL RIG (CENTER ANCHOR)
// ==========================================
function createNullRig(autoParent, statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee Auto Null Rig");
    var count = 0;
    try {
        var curTime = comp.time;

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var centerInComp = null;

            try {
                var rect = layer.sourceRectAtTime(curTime, false);
                var localCenter = [rect.left + (rect.width / 2), rect.top + (rect.height / 2)];
                centerInComp = layer.toComp(localCenter);
            } catch(eRect) {
                try {
                    centerInComp = layer.toComp(layer.transform.anchorPoint.value);
                } catch(eAP) {
                    centerInComp = layer.transform.position.value;
                }
            }

            var nullLayer = comp.layers.addNull();
            nullLayer.name = "Null_" + layer.name;
            nullLayer.label = 13;

            var nullHalfW = nullLayer.width / 2;
            var nullHalfH = nullLayer.height / 2;
            nullLayer.transform.anchorPoint.setValue([nullHalfW, nullHalfH]);

            if (layer.threeDLayer) {
                nullLayer.threeDLayer = true;
                var zVal = 0;
                try { zVal = layer.transform.position.value[2] || 0; } catch(e3d) {}
                nullLayer.transform.position.setValue([centerInComp[0], centerInComp[1], zVal]);
            } else {
                nullLayer.transform.position.setValue([centerInComp[0], centerInComp[1]]);
            }

            nullLayer.startTime = layer.startTime;
            nullLayer.inPoint = layer.inPoint;
            nullLayer.outPoint = layer.outPoint;

            nullLayer.moveBefore(layer);

            if (autoParent) {
                var oldParent = layer.parent;
                if (oldParent) {
                    nullLayer.parent = oldParent;
                }
                layer.parent = nullLayer;
            }

            count++;
        }
        if (statusLabel) statusLabel.text = "Created " + count + " Null layer(s) at the asset visual centre";
    } catch(e) {
        alert("Error createNullRig: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

function centerAssetAnchorPoint(statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee Center Asset Anchor Point");
    var count = 0;
    try {
        var curTime = comp.time;
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var tf = layer.transform;
            if (!tf || !tf.anchorPoint || !tf.position) continue;

            var rect = layer.sourceRectAtTime(curTime, false);
            var newAnchor = [rect.left + (rect.width / 2), rect.top + (rect.height / 2)];

            var curCompPos = layer.toComp(tf.anchorPoint.value);
            tf.anchorPoint.setValue(newAnchor);
            var newCompPos = layer.toComp(newAnchor);

            var deltaX = curCompPos[0] - newCompPos[0];
            var deltaY = curCompPos[1] - newCompPos[1];

            if (tf.position.dimensionsSeparated) {
                tf.xPosition.setValue(tf.xPosition.value + deltaX);
                tf.yPosition.setValue(tf.yPosition.value + deltaY);
            } else {
                var curPos = tf.position.value;
                if (layer.threeDLayer && curPos.length > 2) {
                    tf.position.setValue([curPos[0] + deltaX, curPos[1] + deltaY, curPos[2]]);
                } else {
                    tf.position.setValue([curPos[0] + deltaX, curPos[1] + deltaY]);
                }
            }
            count++;
        }
        if (statusLabel) statusLabel.text = "Centred the anchor point of " + count + " layer(s)";
    } catch(e) {
        alert("Error centerAssetAnchorPoint: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// ENTRY POINTS  (called by the panel through evalScript)
// ==========================================
function fgPop(dir, dist, frames) {
    return fgWrap(function () { applyPositionPop(dir, dist, frames, FG_STATUS); });
}
function fgCurve(isIn, dur) {
    return fgWrap(function () { applyCurveTransition(isIn, dur, FG_STATUS); });
}
function fgOverlap(down, step) {
    return fgWrap(function () { applyOverlap(down, step, FG_STATUS); });
}
function fgWiggle(doPos, doRot) {
    return fgWrap(function () { applyWiggleExpressions(doPos, doRot, FG_STATUS); });
}
function fgWiggleClear() {
    return fgWrap(function () { removeWiggleExpressions(FG_STATUS); });
}
function fgTurbulent() {
    return fgWrap(function () { applyTurbulentDisplace(FG_STATUS); });
}
function fgTurbulentRemove() {
    return fgWrap(function () { removeTurbulentDisplace(FG_STATUS); });
}
function fgNullRig(autoParent) {
    return fgWrap(function () { createNullRig(autoParent, FG_STATUS); });
}
function fgCenterAnchor() {
    return fgWrap(function () { centerAssetAnchorPoint(FG_STATUS); });
}

// Called by the panel on boot to confirm the host script loaded.
function fgPing() {
    try { return "OK|Host ready - AE " + app.version.split("x")[0]; }
    catch (e) { return "OK|Host ready"; }
}

// ---- the only global this file creates ----
return {
    pop: fgPop,
    curve: fgCurve,
    overlap: fgOverlap,
    wiggle: fgWiggle,
    wiggleClear: fgWiggleClear,
    turbulent: fgTurbulent,
    turbulentRemove: fgTurbulentRemove,
    nullRig: fgNullRig,
    centerAnchor: fgCenterAnchor,
    ping: fgPing
};

})();
