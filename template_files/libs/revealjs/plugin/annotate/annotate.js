// Freehand annotation for reveal.js — pen, highlighter and eraser.
//
// This replaces the reveal.js chalkboard plugin, whose ink is painted straight
// onto a <canvas>. Here a stroke is instead kept as what it really is: a list of
// points. perfect-freehand (MIT, vendored alongside this file) turns each list
// into the outline of a pressure-styled stroke, which we render as one SVG
// <path>. Keeping strokes as objects rather than pixels is what makes the rest
// fall out cheaply:
//
//   * erasing removes a whole stroke — hit-test the pointer against its points
//     and drop it, rather than scrubbing pixels, and a stroke that is a
//     scribble over other strokes can rub them out without reaching for a tool;
//   * undo/redo is a snapshot of the (small) per-slide stroke list;
//   * persistence is JSON.stringify into localStorage, keyed by deck and slide;
//   * the ink is resolution-independent, so it stays sharp on HiDPI screens and
//     when the window is resized — both of which needed workarounds under the
//     canvas-based plugin.
//
// The ink is drawn on SVG layers inside `.reveal .slides`, so they inherit
// reveal's slide transform: we can work in slide coordinates (the deck's
// configured width × height) and let the browser scale the result. That also
// makes stored strokes independent of the window size they were drawn at.
// Styling — and why there is a layer per tool — is in annotate.scss.
(function () {
  if (!window.perfectFreehand) return;
  var getStroke = perfectFreehand.getStroke;

  /* ---------------------------- configuration ---------------------------- */

  var COLOURS = [
    ['Black', '#252525'], ['Red', '#d94827'], ['Blue', '#2668c7'],
    ['Green', '#0f9d58'], ['Orange', '#e8710a']
  ];

  // How wide each tool draws, in slide coordinates. These defaults are tuned
  // for handwriting at the deck's corrected, browser-independent scale.
  var WIDTHS = { pen: 12.3, highlighter: 86 };

  // The rest of what perfect-freehand needs, which is what gives a stroke its
  // shape rather than its weight: how far pressure narrows it, how much the
  // input is smoothed and how far it lags the tip. Taken from the ../scribble
  // deck, and unlike the widths they came over as they stood.
  //
  // The pen carries a second set for a device with no pressure of its own,
  // where perfect-freehand guesses it from how fast the stroke is drawn; that
  // guess suits a narrower nib, so `share` takes it to 0.62 of the width above.
  var TOOLS = {
    pen: {
      thinning: 0.85, smoothing: 0.62, streamline: 0.62,
      easing: function (t) { return t * 0.65 + Math.sin(t * Math.PI / 2) * 0.35; },
      simulated: {
        share: 0.62, thinning: 0.5, smoothing: 0.62, streamline: 0.64,
        easing: function (t) { return Math.sin(t * Math.PI / 2); }
      }
    },
    highlighter: { thinning: 0, smoothing: 0.5, streamline: 0.5 }
  };

  // The widths above are a starting point, not the last word: how thick a line
  // has to be depends on the room and the projector, and neither is known here.
  // The panel's − and + take the tool in hand between these multiples of its
  // width, and what they settle on is kept in localStorage — as a width rather
  // than as a multiple, so that changing the defaults above never compounds
  // with a choice already made — for every deck on the device.
  var NIB = { min: 0.25, max: 3, step: 1.25 };
  var WIDTH_STORE = 'reveal-ink-width-v2';

  // Black ink is black, but a black *highlighter* is a grey smear over the
  // words it is meant to pick out. The first swatch draws — and shows itself
  // as — the colour a highlighter actually is while that tool is in hand.
  var HIGHLIGHT = '#facc15';

  var ERASER = 10;      // eraser hit radius, in slide coordinates
  var RESIZE_HANDLE = 12; // selection-corner display and touch hit radius
  var UNDO_DEPTH = 40;  // snapshots kept per slide

  // How far each layer reaches beyond the slide, as a multiple of the deck's
  // The layers fill the fixed stage, which is the whole authored page. Nothing
  // is letterboxed inside it, so a pointer that goes down anywhere on screen is
  // already over the layer and no overscan is needed; before the stage existed
  // this was 1, covering a deck's width and height either side of the slide.
  var OVERSCAN = 0;

  // Ink is drawn and stored in the coordinates of the authored page. The stage
  // publishes that page's size on itself, which is the same value its own fit
  // transform uses, so there is one source of truth and nothing to keep in
  // step by hand. Without a stage, the reveal frame is the page.
  function pageSize() {
    var stage = document.querySelector('[data-deck-stage]');
    if (stage) {
      var css = getComputedStyle(stage);
      return [
        parseFloat(css.getPropertyValue('--deck-width')) || stage.offsetWidth,
        parseFloat(css.getPropertyValue('--deck-height')) || stage.offsetHeight
      ];
    }
    var cfg = Reveal.getConfig();
    return [parseFloat(cfg.width) || 960, parseFloat(cfg.height) || 700];
  }

  // Scribbling over a mistake is the gesture everyone already makes on paper,
  // and it saves reaching for the eraser and back mid-sentence. The thresholds
  // below keep it a narrow gesture: a stroke that sweeps back along its own
  // long axis at least three times *and* crosses one stroke's ink repeatedly.
  // An advancing zigzag or a sine wave progresses steadily along its long axis
  // and so is not a scribble, which is how a sketched waveform stays a sketch;
  // and because the crossings are counted per stroke, a slash through an
  // equation or an arrow across a derivation never adds up to a trigger.
  var SCRIBBLE = {
    reversals: 2,   // direction reversals along the long axis; 2 is a Z
    travel: 10,     // how far a reversal must go to be one, not end-of-stroke wobble
    overlap: 0.5,   // bounding-box overlap needed before counting crossings
    crossings: 3,   // crossings with a *single* stroke before it is erased
    slack: 4,       // padding on every box, so a straight stroke has an area
    tolerance: 2    // simplification tolerance; ink is sampled far finer than needed
  };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STORE = 'reveal-ink:' + location.pathname;
  var PRINT = /(?:^|[?&])print-pdf(?:[=&]|$)/i.test(location.search);
  var PRINT_INK = PRINT && /(?:^|[?&])ink(?:[=&]|$)/i.test(location.search);
  var RULE_STORE = 'reveal-ink-rules';
  var RULE_SPACING_STORE = 'reveal-ink-rule-spacing';
  var PRESSURE_STORE = 'reveal-ink-pressure';
  var DIAGNOSTIC_LIMIT = 12000;
  // Centre ordinary light Pencil writing near perfect-freehand's neutral 0.5
  // width, while retaining useful room on either side for pressure variation.
  var PRESSURE = { enabledByDefault: true, baseline: 0.35, scale: 0.75 };
  var RULES = { spacing: 52, min: 28, max: 92, step: 8, margin: 64 };
  var TEXT = { size: 34, width: 360, lineHeight: 1.25, padding: 0.16, dragThreshold: 6 };

  /* -------------------------------- state -------------------------------- */

  // Ink is either a pressure-shaped stroke, or a text box with { t: 'text',
  // c: colour, f: font size, v: value, p: four box corners }. Everything that
  // affects rendering travels with the annotation.
  var widths = readWidths(); // active presets for the next stroke of each tool
  var ink = read();
  var undos = {}, redos = {};// { slideKey: [JSON snapshot, ...] }
  var tool = 'pen';          // this deck opens ready to write
  var lastTool = 'pen';      // restored after temporarily hiding the tools
  var hidden = false;        // the ink is parked, showing the slide underneath
  var chrome = true;         // the bottom-left corner buttons are on show
  var ruled = readRules();    // local view preference; never part of shared ink
  var ruleSpacing = readRuleSpacing(); // browser-local guide density
  var pressureEnabled = readPressure(); // captured into each new stroke's points
  var colour = COLOURS[0][1];
  var moreOpen = false;       // session controls expand beside the writing rail
  var lastWheel = 0;          // one colour step per physical wheel gesture
  var live = null;           // { stroke, trail } while a stroke is being drawn
  var erasing = false;       // an eraser drag is in progress
  var held = null;           // the tool the right button borrowed the eraser from
  var armed = false;         // the live stroke has been recognised as a scribble
  var marked = [];           // strokes the eraser or scribble takes when let go
  var selected = [];         // strokes enclosed by the current lasso
  var lasso = null;          // { p, el } while a selection loop is being drawn
  var moving = null;         // original points while selected strokes are dragged
  var resizing = null;       // fixed corner and originals while selection scales
  var textMoving = null;     // pending tap, or direct drag, on committed text
  var editing = null;        // in-place textarea and its uncommitted text-box draft
  var clipboard = null;      // copied strokes survive slide changes for this session
  var nodes = new WeakMap(); // annotation -> its SVG element
  var thinned = new WeakMap();// stroke -> its simplified points
  var layers = {};           // one SVG per rendered annotation type; see build()
  var view;                  // every layer's viewBox, in slide coordinates
  // On an iPad this deck assumes an Apple Pencil is available, so fingers are
  // navigation/palm input from the first touch. Elsewhere, touch and mouse can
  // doodle until an actual pen is observed.
  var pen = AnnotationModel.isIPad(navigator);
  var stylus = false;        // the stroke in hand has a pressure of its own
  var pointers = false;      // pointer events arrive here, so touches are ignored
  var touching = null;       // identifier of the touch a stroke is being drawn with
  var activePointer = null;  // only this contact may move or finish the live gesture
  var hovers = 0;            // consecutive hovering mouse moves; see hover()
  var sessionStarted = Date.now();
  var diagnostics = [];      // bounded, session-only input trace; exported with ink
  var W, H, slides, surface, panel, picker, guide, rulesPath, selectionLayer, selectionBox, saveTimer;

  /* ------------------------------ stroke maths --------------------------- */

  // The nib a stroke was drawn with. Ink saved before strokes carried their own
  // width falls back to the nib in hand, so an old file still draws.
  function nib(stroke) {
    return stroke.w > 0 ? stroke.w : widths[stroke.t];
  }

  // perfect-freehand returns the stroke's outline as a polygon; draw it as a
  // path of quadratic curves through the midpoints, which rounds the corners.
  function pathData(stroke, unfinished) {
    var o = TOOLS[stroke.t];
    if (stroke.s && o.simulated) o = o.simulated;
    var pts = getStroke(stroke.p, {
      size: nib(stroke) * (o.share || 1),
      thinning: o.thinning, smoothing: o.smoothing,
      streamline: o.streamline, easing: o.easing,
      simulatePressure: stroke.s, last: !unfinished
    });
    if (!pts.length) return '';
    var d = ['M', pts[0][0], pts[0][1], 'Q'];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      d.push(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
    return d.join(' ') + ' Z';
  }

  function pathFor(stroke, unfinished) {
    var el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('fill', stroke.c);
    el.setAttribute('d', pathData(stroke, unfinished));
    return el;
  }

  // A stroke in progress is redrawn every frame, and pathData() builds its
  // outline from all of its points: the longer the line, the more it costs to
  // add anything to it, and by the time one crosses the page the frame is spent
  // rebuilding what has not changed. The garbage that leaves behind — an
  // outline and a path string of tens of kilobytes, sixty times a second — is
  // what makes a long line arrive in pulses: smooth for a second or two, a
  // pause while the collector runs, and again.
  //
  // So the settled part of a stroke is frozen into a path of its own and left
  // alone, and only the tail is rebuilt. Each frozen piece runs OVERLAP points
  // past where the tail picks up, hiding both the blunt end perfect-freehand
  // leaves on an unfinished stroke and the thin start it gives the next one;
  // same colour, same layer, and a layer carries its opacity as a whole, so
  // overlapping pieces do not compound and nothing shows where they meet. When
  // the stroke ends the pieces go and it is drawn once, whole: everything
  // downstream — erasing, undo, saving, the PDF — still sees one stroke.
  var CHUNK = 128;   // points the tail grows to before it is frozen
  var OVERLAP = 16;  // points a frozen piece and the tail have in common

  function part(stroke, from, to) {
    return { t: stroke.t, c: stroke.c, w: stroke.w, s: stroke.s, p: stroke.p.slice(from, to) };
  }

  function Trail(stroke, layer) {
    this.stroke = stroke;
    this.layer = layer;
    this.base = 0;        // where the tail starts, in the stroke's points
    this.pieces = [];
    this.el = pathFor(stroke, true);
    layer.appendChild(this.el);
  }

  Trail.prototype.draw = function () {
    if (this.stroke.p.length - this.base > CHUNK + OVERLAP) {
      var cut = this.base + CHUNK;
      var piece = pathFor(part(this.stroke, this.base, cut + OVERLAP), true);
      this.layer.insertBefore(piece, this.el);
      this.pieces.push(piece);
      this.base = cut;
    }
    this.el.setAttribute('d', pathData(part(this.stroke, this.base), true));
  };

  // The stroke is finished: one path for the whole of it, tapered end and all,
  // and the pieces that carried it while it was being drawn are taken away.
  Trail.prototype.close = function () {
    this.pieces.forEach(function (el) { el.remove(); });
    this.pieces = [];
    this.el.setAttribute('d', pathData(this.stroke));
  };

  Trail.prototype.fade = function () {
    this.el.classList.add('ink-fading');
    this.pieces.forEach(function (el) { el.classList.add('ink-fading'); });
  };

  function isText(annotation) { return annotation && annotation.t === 'text'; }

  function boxPoints(x, y, width, height) {
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  }

  function itemBox(annotation) {
    return AnnotationGeometry.pointsBounds(annotation && annotation.p || []);
  }

  var measureCanvas, measureContext;
  function measureText(value, size) {
    if (!measureCanvas) {
      measureCanvas = document.createElement('canvas');
      measureContext = measureCanvas.getContext('2d');
    }
    measureContext.font = size + 'px system-ui, sans-serif';
    return measureContext.measureText(value).width;
  }

  function textLines(annotation) {
    var box = itemBox(annotation);
    var padding = annotation.f * TEXT.padding;
    var available = Math.max(annotation.f, (box ? box[2] - box[0] : TEXT.width) - 2 * padding);
    var lines = [];
    String(annotation.v || '').split('\n').forEach(function (paragraph) {
      if (!paragraph) { lines.push(''); return; }
      var line = '';
      paragraph.split(/\s+/).forEach(function (word) {
        var candidate = line ? line + ' ' + word : word;
        if (line && measureText(candidate, annotation.f) > available) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      });
      lines.push(line);
    });
    return lines.length ? lines : [''];
  }

  function fitTextBox(annotation) {
    var box = itemBox(annotation);
    var x = box ? box[0] : 0, y = box ? box[1] : 0;
    var width = box ? box[2] - box[0] : TEXT.width;
    var padding = annotation.f * TEXT.padding;
    var height = textLines(annotation).length * annotation.f * TEXT.lineHeight + 2 * padding;
    annotation.p = boxPoints(x, y, width, height);
  }

  function textFor(annotation) {
    var box = itemBox(annotation), padding = annotation.f * TEXT.padding;
    var group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'ink-text-item');
    group.setAttribute('aria-label', annotation.v || 'Text box');
    var text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', box[0] + padding);
    text.setAttribute('y', box[1] + padding + annotation.f);
    text.setAttribute('fill', annotation.c);
    text.setAttribute('font-size', annotation.f);
    text.setAttribute('font-family', 'system-ui, sans-serif');
    textLines(annotation).forEach(function (line, index) {
      var span = document.createElementNS(SVG_NS, 'tspan');
      span.setAttribute('x', box[0] + padding);
      if (index) span.setAttribute('dy', annotation.f * TEXT.lineHeight);
      span.textContent = line || '\u00a0';
      text.appendChild(span);
    });
    group.appendChild(text);
    return group;
  }

  function elementFor(annotation, unfinished) {
    return isText(annotation) ? textFor(annotation) : pathFor(annotation, unfinished);
  }

  function updateElement(annotation) {
    var old = nodes.get(annotation);
    if (!old) return;
    if (isText(annotation)) {
      var replacement = textFor(annotation);
      old.replaceWith(replacement);
      nodes.set(annotation, replacement);
    } else {
      old.setAttribute('d', pathData(annotation));
    }
  }

  // Distance from (x, y) to the segment a–b: erasing tests segments, not just
  // points, so a fast (and therefore sparsely sampled) stroke is still hit.
  function segDist(x, y, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    var t = len ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len)) : 0;
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  }

  function touches(stroke, x, y) {
    if (isText(stroke)) return AnnotationGeometry.insideBounds([x, y], itemBox(stroke), ERASER);
    var r = ERASER + nib(stroke) / 2, p = stroke.p;
    for (var i = 0; i < p.length; i++) {
      if (segDist(x, y, p[i], p[i + 1] || p[i]) <= r) return true;
    }
    return false;
  }

  function selectedBounds() {
    return AnnotationGeometry.pointsBounds(selected.reduce(function (all, s) {
      return all.concat(s.p);
    }, []));
  }

  // Ramer-Douglas-Peucker: drop the points that are not doing anything, so the
  // scribble tests below compare tens of segments rather than hundreds.
  function simplify(p, tol) {
    if (p.length < 3) return p;
    var a = p[0], b = p[p.length - 1], far = 0, max = -1;
    for (var i = 1; i < p.length - 1; i++) {
      var d = segDist(p[i][0], p[i][1], a, b);
      if (d > max) { max = d; far = i; }
    }
    if (max <= tol) return [a, b];
    return simplify(p.slice(0, far + 1), tol).slice(0, -1).concat(simplify(p.slice(far), tol));
  }

  // Finished strokes never change, so simplify each of them once.
  function thin(stroke) {
    var p = thinned.get(stroke);
    if (!p) thinned.set(stroke, p = simplify(stroke.p, SCRIBBLE.tolerance));
    return p;
  }

  // Padded, so that a perfectly straight stroke — a fraction bar, an axis — has
  // an area to overlap with and can still be scribbled out.
  function bounds(p) {
    var s = SCRIBBLE.slack;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < p.length; i++) {
      x0 = Math.min(x0, p[i][0]); x1 = Math.max(x1, p[i][0]);
      y0 = Math.min(y0, p[i][1]); y1 = Math.max(y1, p[i][1]);
    }
    return [x0 - s, y0 - s, x1 + s, y1 + s];
  }

  // Intersection area as a fraction of the smaller box: a cheap filter that
  // costs nothing, ahead of the crossing count that actually decides.
  function overlap(a, b) {
    var w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    var h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (w <= 0 || h <= 0) return 0;
    return w * h / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  }

  // The direction of greatest variance: the first principal component, which
  // for a 2x2 covariance matrix is one line of algebra rather than anything
  // iterative.
  function axis(p) {
    var mx = 0, my = 0, xx = 0, xy = 0, yy = 0, i;
    for (i = 0; i < p.length; i++) { mx += p[i][0]; my += p[i][1]; }
    mx /= p.length; my /= p.length;
    for (i = 0; i < p.length; i++) {
      var dx = p[i][0] - mx, dy = p[i][1] - my;
      xx += dx * dx; xy += dx * dy; yy += dy * dy;
    }
    var a = 0.5 * Math.atan2(2 * xy, xx - yy);
    return [Math.cos(a), Math.sin(a)];
  }

  // How many times a stroke doubles back along its own long axis. Measuring
  // along that axis is what separates a scribble, which sweeps back over
  // itself, from a wave, which keeps going however much it wiggles across it.
  // `travel` is hysteresis: the stroke has to come back a real distance rather
  // than jitter over a turning point.
  function reversals(p) {
    var u = axis(p), n = 0, dir = 0, turn = null;
    for (var i = 0; i < p.length; i++) {
      var at = p[i][0] * u[0] + p[i][1] * u[1];
      if (turn === null) { turn = at; continue; }
      var d = at - turn;
      if (!dir) {
        if (Math.abs(d) >= SCRIBBLE.travel) { dir = d > 0 ? 1 : -1; turn = at; }
      } else if (d * dir > 0) {
        turn = at;  // still going the same way; carry the turning point along
      } else if (Math.abs(d) >= SCRIBBLE.travel) {
        n++; dir = -dir; turn = at;
      }
    }
    return n;
  }

  // Segment-segment crossings between two polylines, up to `limit` — the caller
  // only asks whether there are at least that many, so stop counting there.
  function crossings(a, b, limit) {
    var n = 0;
    for (var i = 1; i < a.length; i++) {
      for (var j = 1; j < b.length; j++) {
        if (crosses(a[i - 1], a[i], b[j - 1], b[j]) && ++n >= limit) return n;
      }
    }
    return n;
  }

  function crosses(a, b, c, d) {
    function side(p, q, r) {
      return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    }
    // Each segment must have the other's endpoints on opposite sides of it.
    return (side(c, d, a) > 0) !== (side(c, d, b) > 0) &&
      (side(a, b, c) > 0) !== (side(a, b, d) > 0);
  }

  /* ------------------------------- the model ----------------------------- */

  function slideKeyFor(slide) {
    return AnnotationModel.slideKey(slide, slide && Reveal.getIndices(slide));
  }

  function slideKey() {
    return slideKeyFor(Reveal.getCurrentSlide());
  }

  function strokes() { return ink[slideKey()] || []; }

  // Call before every change: records the state to come back to, and drops the
  // redo branch we are about to diverge from. Every slide has its own stacks,
  // so a change to another slide's ink says which.
  function snapshot(key) {
    key = key || slideKey();
    var stack = undos[key] = undos[key] || [];
    stack.push(JSON.stringify(ink[key] || []));
    if (stack.length > UNDO_DEPTH) stack.shift();
    redos[key] = [];
  }

  // Undo and redo are the same move in opposite directions.
  function step(from, to) {
    var key = slideKey();
    if (!from[key] || !from[key].length) return;
    (to[key] = to[key] || []).push(JSON.stringify(ink[key] || []));
    ink[key] = JSON.parse(from[key].pop());
    render();
    save();
  }

  // This slide, or with Shift the whole deck. A deck-wide clear asks first: it
  // is undoable, but only a slide at a time, so putting it all back is a walk
  // through the deck rather than one ⌘Z.
  function clear(all) {
    var keys = Object.keys(ink).filter(function (k) { return ink[k].length; });
    if (!all) keys = keys.filter(function (k) { return k === slideKey(); });
    if (!keys.length) return;
    if (all && !confirm('Clear the annotations on all ' + keys.length + ' annotated slides?')) return;
    keys.forEach(function (k) { snapshot(k); ink[k] = []; });
    render();
    save();
  }

  function deletePage() {
    if (!window.AnnotatePages || !AnnotatePages.canRemove()) return;
    if (!confirm('Delete this page and all of its annotations? This cannot be undone.')) return;
    if (activePointer !== null) finishGesture();
    if (editing) finishText(true);
    var key = slideKey();
    delete ink[key];
    delete undos[key];
    delete redos[key];
    save();
    AnnotatePages.removeCurrent();
    sync();
  }

  // Marks rather than deletes: what the eraser has passed over fades, and only
  // goes when the eraser is lifted — the same two steps as the scribble
  // gesture, so a slip can be seen and undone before it costs anything.
  function erase(x, y) {
    strokes().forEach(function (s) {
      if (marked.indexOf(s) !== -1 || !touches(s, x, y)) return;
      if (!marked.length) snapshot();  // one undo entry per drag, not per stroke
      marked.push(s);
      var el = nodes.get(s);
      if (el) el.classList.add('ink-fading');
    });
  }

  function read() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
  }

  function readWidths() {
    var out = {}, saved;
    try { saved = JSON.parse(localStorage.getItem(WIDTH_STORE)); } catch (e) { /* unreadable */ }
    Object.keys(WIDTHS).forEach(function (t) {
      out[t] = saved && saved[t] > 0 ? clampWidth(t, saved[t]) : WIDTHS[t];
    });
    return out;
  }

  function readRules() {
    try { return localStorage.getItem(RULE_STORE) === 'true'; } catch (e) { return false; }
  }

  function readRuleSpacing() {
    var saved;
    try { saved = parseFloat(localStorage.getItem(RULE_SPACING_STORE)); } catch (e) { /* blocked */ }
    return isFinite(saved) ? Math.min(RULES.max, Math.max(RULES.min, saved)) : RULES.spacing;
  }

  function readPressure() {
    var saved;
    try { saved = localStorage.getItem(PRESSURE_STORE); } catch (e) { /* blocked */ }
    return saved === null || saved === undefined ? PRESSURE.enabledByDefault : saved === 'true';
  }

  function togglePressure() {
    pressureEnabled = !pressureEnabled;
    try { localStorage.setItem(PRESSURE_STORE, pressureEnabled); } catch (e) { /* full or blocked */ }
    sync();
  }

  function toggleRules() {
    ruled = !ruled;
    try { localStorage.setItem(RULE_STORE, ruled); } catch (e) { /* full or blocked */ }
    renderOverview();
    sync();
  }

  function rulePathData() {
    return AnnotationGeometry.rulePositions(H, ruleSpacing, RULES.margin)
      .map(function (y) { return 'M' + RULES.margin + ' ' + y + 'H' + (W - RULES.margin); })
      .join(' ');
  }

  function drawRules() {
    rulesPath.setAttribute('d', rulePathData());
  }

  function resizeRules(farther) {
    ruleSpacing = Math.min(RULES.max, Math.max(RULES.min,
      ruleSpacing + (farther ? RULES.step : -RULES.step)));
    try { localStorage.setItem(RULE_SPACING_STORE, ruleSpacing); } catch (e) { /* full or blocked */ }
    drawRules();
    renderOverview();
    sync();
  }

  function clampWidth(t, w) {
    return Math.min(WIDTHS[t] * NIB.max, Math.max(WIDTHS[t] * NIB.min, w));
  }

  // One press of − or + changes the preset for the next stroke only. Finished
  // strokes carry their own width, just as they carry colour and pressure.
  function resize(up) {
    var w = widths[tool] * (up ? NIB.step : 1 / NIB.step);
    widths[tool] = clampWidth(tool, Math.round(w * 10) / 10);
    try { localStorage.setItem(WIDTH_STORE, JSON.stringify(widths)); } catch (e) { /* full or blocked */ }
    sync();
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORE, JSON.stringify(kept()));
      } catch (e) { /* full or blocked */ }
    }, 400);
  }

  function kept() {
    var out = {};
    Object.keys(ink).forEach(function (k) { if (ink[k].length) out[k] = ink[k]; });
    return out;
  }

  function gestureState() {
    return {
      tool: tool, slide: slideKey(), activePointer: activePointer,
      live: !!live, erasing: erasing, lasso: !!lasso, moving: !!moving,
      resizing: !!resizing,
      touching: touching, held: held, penSeen: pen, pointersSeen: pointers,
      hidden: hidden
    };
  }

  function trace(type, e, handled, note) {
    var touch = e && e.changedTouches && e.changedTouches.length ? e.changedTouches[0] : null;
    var p = touch || e || {};
    var target = e && e.target;
    diagnostics.push({
      ms: Date.now() - sessionStarted,
      type: type,
      handled: !!handled,
      note: note || undefined,
      pointerId: p.pointerId !== undefined ? p.pointerId :
        (p.identifier !== undefined ? 'touch:' + p.identifier : undefined),
      pointerType: p.pointerType || p.touchType || undefined,
      button: p.button,
      buttons: p.buttons,
      pressure: p.pressure !== undefined ? p.pressure : p.force,
      x: isFinite(p.clientX) ? Math.round(p.clientX) : undefined,
      y: isFinite(p.clientY) ? Math.round(p.clientY) : undefined,
      changedTouches: e && e.changedTouches ? e.changedTouches.length : undefined,
      touches: e && e.touches ? e.touches.length : undefined,
      cancelable: e ? !!e.cancelable : undefined,
      target: target ? (target.id || target.className || target.tagName || '').toString().slice(0, 100) : undefined,
      state: gestureState()
    });
    if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.splice(0, diagnostics.length - DIAGNOSTIC_LIMIT);
  }

  function diagnosticReport() {
    return {
      sessionStartedAt: new Date(sessionStarted).toISOString(),
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio },
      state: gestureState(),
      events: diagnostics
    };
  }

  function saveBlob(blob, filename) {
    var href = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = href;
    a.download = filename;
    panel.appendChild(a);  // not every browser follows a link that isn't in the page
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 5000);
  }

  // localStorage is this browser on this machine: the ink does not follow the
  // deck to another device, and clearing site data takes it. These two put a
  // whole deck's ink in a file and read one back. The ink remains keyed by
  // slide so it lands back where it was drawn; exports also wrap a bounded
  // session trace that can diagnose intermittent input failures.
  function download() {
    var name = (location.pathname.split('/').pop() || 'slides').replace(/\.html?$/, '');
    var payload = {
      format: 'scribble-ink',
      version: 6,
      canvas: { width: W, height: H },
      pages: window.AnnotatePages ? AnnotatePages.count() : Reveal.getTotalSlides(),
      pageIds: window.AnnotatePages ? AnnotatePages.ids() : undefined,
      ink: kept(),
      diagnostics: diagnosticReport()
    };
    saveBlob(
      new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      name + '-ink.json'
    );
  }

  function upload(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (e) { return; }
      if (!data || data.format !== 'scribble-ink' || data.version !== 6 ||
          !data.ink || typeof data.ink !== 'object') {
        alert('This annotation file uses an unsupported format.');
        return;
      }
      ink = data.ink;
      if (window.AnnotatePages) {
        if (Array.isArray(data.pageIds)) AnnotatePages.ensureIds(data.pageIds);
        AnnotatePages.ensureForKeys(Object.keys(ink));
        AnnotatePages.ensure(Number(data.pages) || 1);
      }
      undos = {};  // the ink these described is not the ink that is here now
      redos = {};
      clipboard = null;
      render();
      save();
    };
    reader.readAsText(file);
  }

  /* ---------------------------- ink in the PDF --------------------------- */

  // Include every printable leaf section, including slides reveal deliberately
  // leaves out of its counted-slide list. Fragment animation states remain one
  // page because they live inside the same section.
  function printableSlides() {
    var root = Reveal.getSlidesElement ? Reveal.getSlidesElement() : document.querySelector('.reveal .slides');
    var result = [];
    if (!root) return result;
    Array.prototype.forEach.call(root.children, function (horizontal) {
      if (horizontal.tagName !== 'SECTION' || horizontal.dataset.visibility === 'hidden') return;
      var verticals = Array.prototype.filter.call(horizontal.children, function (child) {
        return child.tagName === 'SECTION' && child.dataset.visibility !== 'hidden';
      });
      if (verticals.length) result = result.concat(verticals);
      else result.push(horizontal);
    });
    return result;
  }

  // Scribble's pages have no authored slide content, so they can be emitted
  // directly as compact vector PDF pages. This bypasses the operating system's
  // print-paper choices entirely — notably iPad Safari's forced A4 page — while
  // retaining the exact deck aspect ratio, ruled guides and pressure-shaped ink.
  function downloadPdf() {
    if (!window.AnnotationPdf) return printPdf();
    try {
      var pages = printableSlides().map(function (slide) {
        var list = ink[AnnotationModel.slideKey(slide)] || [];
        return {
          strokes: list.filter(function (annotation) { return !isText(annotation); }).map(function (stroke) {
            return { tool: stroke.t, colour: stroke.c, path: pathData(stroke) };
          }),
          text: list.filter(isText).map(function (annotation) {
            var box = itemBox(annotation);
            return {
              x: box[0], y: box[1], fontSize: annotation.f,
              lineHeight: annotation.f * TEXT.lineHeight,
              padding: annotation.f * TEXT.padding,
              colour: annotation.c, lines: textLines(annotation)
            };
          })
        };
      });
      var data = AnnotationPdf.create({
        width: W,
        height: H,
        pages: pages,
        rules: ruled ? AnnotationGeometry.rulePositions(H, ruleSpacing, RULES.margin) : [],
        ruleMargin: RULES.margin
      });
      var name = (document.title || 'Scribble').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-') || 'Scribble';
      saveBlob(new Blob([data], { type: 'application/pdf' }), name + '.pdf');
    } catch (error) {
      console.error('Direct PDF download failed; opening the print view instead.', error);
      printPdf();
    }
  }

  // Open Reveal's own one-slide-per-page print view. Both windows share the
  // same localStorage origin, so the print window can lay the current ink and
  // ruled-guide preference over the pages without uploading either anywhere.
  function printPdf() {
    var url = new URL(location.href);
    url.hash = '';
    url.search = '?print-pdf&pdfMaxPagesPerSlide=1&ink=1';
    window.open(url.href, '_blank');
  }

  // The print view is built asynchronously after Reveal becomes ready. Wait
  // for its page wrappers whether `pdf-ready` fires before or after this file
  // starts, then add inert SVG layers and open the browser print dialog.
  function printInk() {
    var size = pageSize();
    W = size[0];
    H = size[1];
    view = [-OVERSCAN * W, -OVERSCAN * H, (1 + 2 * OVERSCAN) * W, (1 + 2 * OVERSCAN) * H];
    var finished = false;
    function layOut() {
      if (finished) return true;
      var pages = document.querySelectorAll('.pdf-page');
      if (!pages.length) return false;
      finished = true;
      var annotated = 0;
      pages.forEach(function (page) { if (layPrintPage(page)) annotated += 1; });
      settled().then(function () {
        printBar(annotated, pages.length);
        window.print();
      });
      return true;
    }
    if (!layOut()) {
      Reveal.on('pdf-ready', layOut);
      var checks = setInterval(function () { if (layOut()) clearInterval(checks); }, 50);
      setTimeout(function () { clearInterval(checks); }, 10000);
    }
  }

  // Place rules against the exact slide-sized rectangle, then overscanned ink
  // above them. Explicit section IDs survive Reveal's print DOM reshuffle, so
  // authored, uncounted and replacement slides all retrieve their own ink;
  // fragment animation states intentionally retain their containing slide ID.
  function layPrintPage(page) {
    var slide = page.querySelector('section');
    if (!slide) return false;
    var list = ink[AnnotationModel.slideKey(slide)] || [];
    var pr = page.getBoundingClientRect();
    var sr = slide.getBoundingClientRect();
    var scale = (sr.width / W) || 1;
    var left = (pr.width - W * scale) / 2;
    var top = (pr.height - H * scale) / 2;
    page.style.position = 'relative';

    if (ruled) {
      var rules = document.createElementNS(SVG_NS, 'svg');
      rules.setAttribute('class', 'ink-print ink-print-rules');
      rules.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      rules.style.cssText = 'position:absolute;left:' + left + 'px;top:' + top + 'px' +
        ';width:' + (W * scale) + 'px;height:' + (H * scale) + 'px';
      var rulePath = document.createElementNS(SVG_NS, 'path');
      rulePath.setAttribute('d', rulePathData());
      rules.appendChild(rulePath);
      page.appendChild(rules);
    }

    ['highlighter', 'pen'].forEach(function (t) {
      var drawn = list.filter(function (stroke) { return stroke.t === t; });
      if (!drawn.length) return;
      var layer = document.createElementNS(SVG_NS, 'svg');
      layer.setAttribute('class', 'ink-print ink-' + t);
      layer.setAttribute('viewBox', view.join(' '));
      layer.style.cssText = 'position:absolute' +
        ';left:' + (left - OVERSCAN * W * scale) + 'px' +
        ';top:' + (top - OVERSCAN * H * scale) + 'px' +
        ';width:' + (view[2] * scale) + 'px;height:' + (view[3] * scale) + 'px';
      drawn.forEach(function (stroke) { layer.appendChild(pathFor(stroke)); });
      page.appendChild(layer);
    });
    var text = list.filter(isText);
    if (text.length) {
      var textLayer = document.createElementNS(SVG_NS, 'svg');
      textLayer.setAttribute('class', 'ink-print ink-text');
      textLayer.setAttribute('viewBox', view.join(' '));
      textLayer.style.cssText = 'position:absolute' +
        ';left:' + (left - OVERSCAN * W * scale) + 'px' +
        ';top:' + (top - OVERSCAN * H * scale) + 'px' +
        ';width:' + (view[2] * scale) + 'px;height:' + (view[3] * scale) + 'px';
      text.forEach(function (annotation) { textLayer.appendChild(textFor(annotation)); });
      page.appendChild(textLayer);
    }
    return list.length > 0;
  }

  function settled() {
    var fonts = document.fonts && document.fonts.ready
      ? document.fonts.ready.catch(function () {})
      : Promise.resolve();
    var images = Array.prototype.map.call(document.images, function (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (resolve) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    });
    return Promise.race([
      Promise.all([fonts].concat(images)),
      new Promise(function (resolve) { setTimeout(resolve, 5000); })
    ]);
  }

  // Keep a small retry strip in the print window in case the dialog is closed
  // or sent to a printer accidentally. CSS excludes the strip from the PDF.
  function printBar(annotated, pages) {
    var el = document.createElement('div');
    el.className = 'ink-print-bar';
    el.innerHTML = '<span></span><button type="button">Print / Save PDF</button>' +
      '<button type="button">Close</button>';
    var message = annotated
      ? annotated + (annotated === 1 ? ' annotated slide' : ' annotated slides')
      : 'No annotations saved for this deck';
    if (ruled) message += ' · ruled guides on ' + pages + (pages === 1 ? ' page' : ' pages');
    el.firstChild.textContent = message + ' — turn on Background graphics';
    var buttons = el.querySelectorAll('button');
    buttons[0].addEventListener('click', function () { window.print(); });
    buttons[1].addEventListener('click', function () { window.close(); });
    document.body.appendChild(el);
  }

  /* ----------------------------- text boxes ----------------------------- */

  function textAt(point) {
    for (var i = strokes().length - 1; i >= 0; i--) {
      var annotation = strokes()[i];
      if (isText(annotation) && AnnotationGeometry.insideBounds(point, itemBox(annotation), 0)) {
        return annotation;
      }
    }
    return null;
  }

  function layoutTextEditor() {
    if (!editing) return;
    var slideRect = slides.getBoundingClientRect();
    var box = itemBox(editing.draft);
    var sx = slideRect.width / W, sy = slideRect.height / H;
    var padding = editing.draft.f * TEXT.padding;
    editing.el.style.left = (slideRect.left + box[0] * sx) + 'px';
    editing.el.style.top = (slideRect.top + box[1] * sy) + 'px';
    editing.el.style.width = Math.max(80, (box[2] - box[0]) * sx) + 'px';
    editing.el.style.height = Math.max(38, (box[3] - box[1]) * sy) + 'px';
    editing.el.style.padding = (padding * sy) + 'px ' + (padding * sx) + 'px';
    editing.el.style.fontSize = (editing.draft.f * sy) + 'px';
    editing.el.style.lineHeight = String(TEXT.lineHeight);
    editing.el.style.color = editing.draft.c;
  }

  function finishText(commit) {
    if (!editing) return;
    var session = editing;
    editing = null;
    window.removeEventListener('resize', layoutTextEditor);
    session.el.remove();
    if (!commit) { sync(); return; }

    var value = session.draft.v;
    var changed = session.target
      ? JSON.stringify(session.target) !== JSON.stringify(session.draft)
      : !!value.trim();
    if (!changed) { sync(); return; }

    snapshot(session.key);
    if (!value.trim()) {
      ink[session.key] = (ink[session.key] || []).filter(function (item) {
        return item !== session.target;
      });
    } else if (session.target) {
      session.target.c = session.draft.c;
      session.target.f = session.draft.f;
      session.target.v = session.draft.v;
      session.target.p = session.draft.p;
    } else {
      (ink[session.key] = ink[session.key] || []).push(session.draft);
    }
    render();
    save();
  }

  function editText(point) {
    finishText(true);
    var target = textAt(point);
    var draft = target ? JSON.parse(JSON.stringify(target)) : {
      t: 'text', c: colour, f: TEXT.size, v: '',
      p: boxPoints(Math.min(point[0], W - TEXT.width), point[1], TEXT.width, TEXT.size * 1.6)
    };
    fitTextBox(draft);
    var textarea = document.createElement('textarea');
    textarea.className = 'ink-text-editor';
    textarea.value = draft.v;
    textarea.placeholder = 'Type text';
    textarea.setAttribute('aria-label', target ? 'Edit text box' : 'New text box');
    textarea.spellcheck = true;
    document.body.appendChild(textarea);
    editing = { key: slideKey(), target: target, draft: draft, el: textarea };
    layoutTextEditor();
    window.addEventListener('resize', layoutTextEditor);
    textarea.addEventListener('input', function () {
      if (!editing || editing.el !== textarea) return;
      editing.draft.v = textarea.value;
      fitTextBox(editing.draft);
      layoutTextEditor();
    });
    textarea.addEventListener('keydown', function (event) {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        finishText(false);
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        finishText(true);
      }
    });
    textarea.addEventListener('blur', function () { finishText(true); });
    try { textarea.focus({ preventScroll: true }); } catch (error) { textarea.focus(); }
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  /* ------------------------------- drawing ------------------------------- */

  // Map a pointer event through Reveal's rendered slide rectangle. This stays
  // correct under slide scaling and zoom, while a point in the surrounding
  // letterbox naturally maps outside [0, W] x [0, H]. Do not measure the
  // overscanned SVG: WebKit historically reported its negative offset but not
  // its expanded dimensions, producing coordinates three times too large.
  function at(e) {
    var point = AnnotationGeometry.pointFromRect(
      [e.clientX, e.clientY], slides.getBoundingClientRect(), W, H
    );
    point.push(Math.round(force(e) * 100) / 100);
    return point;
  }

  // Apple Pencil's light-writing range sits well below the middle of its raw
  // scale. Lift it towards perfect-freehand's neutral 0.5 so enabling pressure
  // changes variation rather than making the whole stroke abruptly narrower.
  // With sensitivity off, a stylus stays at 0.5; non-stylus strokes also store
  // 0.5 but ask perfect-freehand to simulate pressure from their speed.
  function force(e) {
    return AnnotationModel.pressureSample(
      stylus, pressureEnabled, e.pressure, PRESSURE.baseline, PRESSURE.scale
    );
  }

  // The test for a device with pressure to give: it says it is a pen, or the
  // pressure it reports is not one of the three fixed numbers a mouse or a
  // finger gives (0, 0.5 while down, or 1). The second half catches an Apple
  // Pencil driving a Mac over Sidecar, which arrives as a mouse.
  function isStylus(e) {
    return e.pointerType === 'pen' ||
      (e.pressure > 0 && e.pressure < 0.5) || (e.pressure > 0.5 && e.pressure < 1);
  }

  // Pointer events are delivered at most once per frame, but the browser keeps
  // the finer samples it coalesced into each one; using them smooths fast strokes.
  function points(e) {
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    return (evs && evs.length ? evs : [e]).map(at);
  }

  function lassoData(p) {
    if (!p.length) return '';
    return 'M' + p.map(function (q) { return q[0] + ' ' + q[1]; }).join('L') + 'Z';
  }

  function showSelection() {
    selectionLayer.replaceChildren();
    selectionBox = null;
    strokes().forEach(function (s) {
      var el = nodes.get(s);
      if (el) el.classList.toggle('ink-selected', selected.indexOf(s) !== -1);
    });
    var box = selectedBounds();
    if (!box) return;
    selectionBox = document.createElementNS(SVG_NS, 'rect');
    selectionBox.setAttribute('x', box[0]);
    selectionBox.setAttribute('y', box[1]);
    selectionBox.setAttribute('width', Math.max(1, box[2] - box[0]));
    selectionBox.setAttribute('height', Math.max(1, box[3] - box[1]));
    selectionBox.setAttribute('class', 'ink-selection-box');
    selectionLayer.appendChild(selectionBox);
    [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
      .forEach(function (corner) {
        var handle = document.createElementNS(SVG_NS, 'circle');
        handle.setAttribute('cx', corner[0]);
        handle.setAttribute('cy', corner[1]);
        handle.setAttribute('r', RESIZE_HANDLE);
        handle.setAttribute('class', 'ink-resize-handle');
        selectionLayer.appendChild(handle);
      });
  }

  function clearSelection() {
    selected = [];
    lasso = null;
    moving = null;
    resizing = null;
    if (selectionLayer) showSelection();
  }

  function copySelection() {
    if (!selected.length) return;
    clipboard = {
      source: slideKey(),
      strokes: AnnotationModel.cloneStrokes(selected),
      pastes: Object.create(null)
    };
    sync();
  }

  function pasteSelection(options) {
    if (!clipboard || !clipboard.strokes.length) return;
    if (activePointer !== null) finishGesture();
    var key = slideKey();
    var previous = clipboard.pastes[key] || 0;
    // On the source slide, offset the first duplicate so it is visibly a copy.
    // On another slide, preserve its exact position; repeated pastes there fan
    // out slightly instead of landing invisibly on top of one another.
    var offset = (previous + (key === clipboard.source ? 1 : 0)) * 18;
    var dx = offset, dy = offset;
    if (options && isFinite(options.top)) {
      var box = AnnotationGeometry.pointsBounds(clipboard.strokes.reduce(function (all, stroke) {
        return all.concat(stroke.p);
      }, []));
      dx = 0;
      dy = box ? options.top - box[1] : 0;
    }
    var copies = AnnotationModel.cloneStrokes(clipboard.strokes, dx, dy);
    clipboard.pastes[key] = previous + 1;
    snapshot(key);
    ink[key] = (ink[key] || []).concat(copies);
    tool = 'select';
    moreOpen = false;
    render();
    selected = copies;
    showSelection();
    sync();
    save();
  }

  function nextSlide(create) {
    var target = AnnotationModel.nextItem(Reveal.getSlides(), Reveal.getCurrentSlide());
    if (!target && create && window.AnnotatePages) target = AnnotatePages.append();
    return target;
  }

  // The common lecture move as one action: retain a clipboard copy, advance to
  // the next actual reveal section (including an uncounted replacement slide),
  // and place the copied working at the writing margin ready to drag or resize.
  function continueSelection() {
    var target = selected.length && nextSlide(true);
    if (!target) return;
    copySelection();
    var indices = Reveal.getIndices(target);
    var landed = false;
    function land(e) {
      if (landed || (e && e.currentSlide && e.currentSlide !== target)) return;
      if (Reveal.getCurrentSlide() !== target) return;
      landed = true;
      if (Reveal.off) Reveal.off('slidechanged', land);
      requestAnimationFrame(function () { pasteSelection({ top: RULES.margin }); });
    }
    Reveal.on('slidechanged', land);
    Reveal.slide(indices.h, indices.v);
    land();
  }

  function deleteSelection() {
    if (!selected.length) return;
    if (activePointer !== null) finishGesture();
    var gone = selected.slice();
    snapshot();
    ink[slideKey()] = strokes().filter(function (stroke) {
      return gone.indexOf(stroke) === -1;
    });
    render();
    save();
  }

  // The modifier reveal's zoom plugin magnifies on (ctrl on Linux, otherwise
  // alt), honouring an explicit `zoomKey`; the same one the arrow-key panning
  // in reveal-fixes.html looks for.
  function zoomModifier() {
    var cfg = Reveal.getConfig();
    return ((cfg && cfg.zoomKey) || (/Linux/.test(navigator.platform) ? 'ctrl' : 'alt')) + 'Key';
  }

  // The controls a tap has to be able to reach with a tool in hand: ours, and
  // the ones reveal and its plugins put around the slide. Everything else
  // inside the deck — including a link in the middle of a paragraph — is
  // something to draw on, exactly as it was when a box over the slide took the
  // input and covered them all.
  var CHROME = '.ink-panel, .ink-launchers, .ink-text-editor, .controls, .progress, .slide-number,' +
    '.slide-menu, .slide-menu-button, .slide-menu-overlay, .speaker-controls';

  function ours(e) {
    if (!tool) return false;
    // Mid-stroke everything is ours, wherever the tip has wandered to.
    if (live || erasing || lasso || moving || resizing || textMoving || touching !== null) return true;
    var t = e.target;
    return !!t && (!t.closest || !t.closest(CHROME));
  }

  function down(e) {
    if (!tool) return;
    if (e.pointerType === 'pen') pen = true;
    // An Alt/Option-click belongs to the zoom plugin. It magnifies off
    // `mousedown` — a separate event we never touch — so standing aside here is
    // all it takes to stop every magnification leaving a dot behind.
    if (e[zoomModifier()]) return;
    // Once a pen has been used, a finger is a palm resting on the slide or a
    // swipe to the next one — never ink. The event is left alone rather than
    // taken, so reveal still gets to read it as a swipe.
    if (pen && e.pointerType === 'touch') return;
    // A Bluetooth mouse's wheel button alternates the two drawing tools. It is
    // deliberately kept out of the pointer stream, so it cannot leave a dot or
    // start the browser's autoscroll behaviour.
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      clearSelection();
      tool = tool === 'pen' ? 'highlighter' : 'pen';
      lastTool = tool;
      moreOpen = false;
      sync();
      return;
    }
    // Hold the right button — or the barrel button a stylus reports as one, or
    // the inverted end of a pen, which is button 5 — and it erases for as long
    // as it is held: scribble over what is to go, let go, and the tool that was
    // in hand comes back. Erasing is already two steps (what the drag passes
    // over fades, and goes when the drag ends), so a slip costs nothing.
    var borrowed = e.button === 2 || e.button === 5;
    if (e.button && !borrowed) return;      // middle click, and anything else
    if (borrowed && (live || erasing)) return;  // a stroke is already in progress
    // Ignore secondary touch contacts while a gesture is live. A new pen or
    // mouse down means an earlier stream was interrupted (pointer ids may be
    // reused), so finish the abandoned gesture before beginning this one.
    if (activePointer !== null) {
      if (e.pointerType === 'touch') return;
      finishGesture();
    }
    activePointer = e.pointerId;
    e.preventDefault();
    e.stopPropagation();            // keep reveal from reading the drag as a swipe
    moreOpen = false;
    unhover();                      // nothing to point with while the tip is down
    // A stroke survives the pointer leaving the surface; nothing else in the
    // deck wants the events, so carrying on without capture is no worse.
    try { surface.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    if (borrowed) { held = tool; tool = 'eraser'; }
    // Decided once, from the contact that starts the stroke, and held for the
    // rest of it: every point is then read the same way.
    stylus = isStylus(e);
    var p = at(e);
    if (tool === 'text') {
      if (editing) finishText(true);
      var textTarget = textAt(p);
      if (textTarget) {
        textMoving = {
          key: slideKey(), target: textTarget, start: p,
          original: textTarget.p.map(function (q) { return q.slice(); }), moved: false
        };
      } else {
        activePointer = null;
        editText(p);
      }
      sync();
      return;
    }
    if (tool === 'select') {
      var box = selectedBounds();
      var handle = selected.length && AnnotationGeometry.resizeHandle(p, box, RESIZE_HANDLE);
      if (handle) {
        snapshot();
        resizing = {
          anchor: [
            handle.point[0] === box[0] ? box[2] : box[0],
            handle.point[1] === box[1] ? box[3] : box[1]
          ],
          corner: handle.point,
          originals: selected.map(function (s) {
            return s.p.map(function (q) { return q.slice(); });
          }),
          widths: selected.map(function (s) { return s.w; }),
          fonts: selected.map(function (s) { return s.f; })
        };
      } else if (selected.length && AnnotationGeometry.insideBounds(p, box, ERASER)) {
        snapshot();
        moving = {
          start: p,
          originals: selected.map(function (s) { return s.p.map(function (q) { return q.slice(); }); })
        };
      } else {
        clearSelection();
        var el = document.createElementNS(SVG_NS, 'path');
        el.setAttribute('class', 'ink-lasso');
        selectionLayer.appendChild(el);
        lasso = { p: [p], el: el };
      }
      sync();
      return;
    }
    if (tool === 'eraser') { erasing = true; marked = []; erase(p[0], p[1]); sync(); return; }
    snapshot();
    var stroke = { t: tool, c: inkColour(), w: widths[tool], s: !stylus, p: [p] };
    (ink[slideKey()] = ink[slideKey()] || []).push(stroke);
    var trail = new Trail(stroke, layers[tool]);
    live = { stroke: stroke, trail: trail };
    nodes.set(stroke, trail.el);
    armed = false;
    marked = [];
    sync();
  }

  // The crosshair is a mouse's, and it only appears once a mouse has really
  // moved. An Apple Pencil driving a Mac over Sidecar arrives as a mouse that
  // is nowhere at all until the tip touches the glass, and macOS shows the
  // cursor for each of those contacts: a crosshair blinking on and off at the
  // start and end of every stroke. A mouse hovers — a stream of moves with no
  // button held — where a pen contact produces at most a stray one, so two in a
  // row is the difference between them. Pens and fingers never bring it back.
  function hover(e) {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    if (tool === 'text') surface.classList.toggle('ink-text-target', !!textAt(at(e)));
    if (hovers >= 2) return;
    if (++hovers === 2) surface.classList.add('ink-hover');
  }

  function unhover() {
    hovers = 0;
    surface.classList.remove('ink-hover');
    surface.classList.remove('ink-text-target');
  }

  function move(e) {
    if ((live || erasing || lasso || moving || resizing || textMoving) &&
        !AnnotationModel.ownsPointer(activePointer, e.pointerId)) return;
    hover(e);
    if (!live && !erasing && !lasso && !moving && !resizing && !textMoving) return;
    // Reveal navigates on a pointer drag as well as on a touch swipe, and it
    // reads every move, not just the ones that follow a pointerdown it saw. A
    // stroke is not a swipe, so the moves that make it up stop here.
    e.stopPropagation();
    if (erasing) { points(e).forEach(function (p) { erase(p[0], p[1]); }); return; }
    if (lasso) {
      if (!AnnotationModel.appendSamples(lasso.p, points(e)).added) return;
      lasso.el.setAttribute('d', lassoData(lasso.p));
      return;
    }
    if (textMoving) {
      var textHere = at(e);
      var textDx = textHere[0] - textMoving.start[0];
      var textDy = textHere[1] - textMoving.start[1];
      if (!textMoving.moved && Math.hypot(textDx, textDy) < TEXT.dragThreshold) return;
      if (!textMoving.moved) {
        snapshot(textMoving.key);
        textMoving.moved = true;
        sync();
      }
      textMoving.target.p = AnnotationGeometry.translatePoints(
        textMoving.original, textDx, textDy
      );
      updateElement(textMoving.target);
      return;
    }
    if (moving) {
      var here = at(e), dx = here[0] - moving.start[0], dy = here[1] - moving.start[1];
      selected.forEach(function (s, i) {
        s.p = AnnotationGeometry.translatePoints(moving.originals[i], dx, dy);
        if (!isText(s)) thinned.delete(s);
        updateElement(s);
      });
      showSelection();
      return;
    }
    if (resizing) {
      var dragged = at(e);
      var scale = AnnotationGeometry.uniformScale(
        resizing.anchor, resizing.corner, dragged, 0.1);
      selected.forEach(function (s, i) {
        s.p = AnnotationGeometry.scalePoints(resizing.originals[i], resizing.anchor, scale);
        if (isText(s)) s.f = resizing.fonts[i] * scale;
        else s.w = resizing.widths[i] * scale;
        if (!isText(s)) thinned.delete(s);
        updateElement(s);
      });
      showSelection();
      return;
    }
    var added = AnnotationModel.appendSamples(live.stroke.p, points(e));
    if (!added.added && !added.dropped) return;
    live.trail.draw();
    scribble();
  }

  /* --------------------------- drawing from touch ------------------------ */

  // A second way in, for a browser that hands the surface touch events without
  // ever sending it a pointer event. iPadOS does exactly that — which is why
  // the chalkboard plugin this replaced drew from touches — and an Apple
  // Pencil on an iPad is what this whole tool is for.
  //
  // Only ever one of the two paths runs. Pointer events for a gesture are
  // dispatched before its touch events, so the first pointerdown to arrive
  // switches this off for the rest of the session; where pointer events work,
  // these handlers never do anything.
  function touchDown(e) {
    if (pointers || touching !== null) return;
    var t = e.changedTouches[0];
    if (t.touchType === 'stylus') pen = true;
    if (pen && t.touchType !== 'stylus') return;  // a palm, or a swipe
    touching = t.identifier;
    down(asPointer(e, t));
  }

  function touchMove(e) {
    var t = pointers ? null : sameTouch(e);
    if (t) move(asPointer(e, t));
  }

  function touchUp(e) {
    var t = pointers ? null : sameTouch(e);
    if (!t) return;
    touching = null;
    up(asPointer(e, t));
  }

  function sameTouch(e) {
    if (touching === null) return null;
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touching) return e.changedTouches[i];
    }
    return null;
  }

  // A Touch dressed as the pointer event the drawing code above expects. The
  // touch event it came from has already been prevented and stopped, so the
  // two methods have nothing left to do; `pointerId` is missing, which is what
  // makes the pointer capture in down() fail harmlessly.
  function asPointer(e, t) {
    return {
      clientX: t.clientX,
      clientY: t.clientY,
      // Apple Pencil reports its pressure as force. A stylus is a pen whether
      // or not a force came with it; where none did, half — what a mouse reads
      // while it is down — gives the stroke an even, middling width rather
      // than the taper a zero would.
      pressure: t.force > 0 ? t.force : 0.5,
      pointerType: t.touchType === 'stylus' ? 'pen' : 'touch',
      pointerId: 'touch:' + t.identifier,
      button: 0,
      buttons: 1,
      altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
      preventDefault: function () {},
      stopPropagation: function () {}
    };
  }

  function finishGesture() {
    activePointer = null;
    var drawn = live || erasing || lasso || moving || resizing || textMoving;
    unhover();  // a lifted pen leaves no cursor behind; a mouse moves on
    if (lasso) {
      selected = strokes().filter(function (s) {
        return AnnotationGeometry.polygonContainsPoints(lasso.p, s.p);
      });
      lasso = null;
      showSelection();
      sync();
    } else if (moving) {
      moving = null;
      showSelection();
      save();
    } else if (resizing) {
      resizing = null;
      showSelection();
      save();
    } else if (textMoving) {
      var textSession = textMoving;
      textMoving = null;
      if (textSession.moved) save();
      else editText(textSession.start);
      sync();
    } else if (erasing) {
      erasing = false;
      if (marked.length) rub();
    } else if (live) {
      if (marked.length) {
        rub();
      } else {
        live.trail.close();  // one path for the whole stroke, tapered end and all
        live = null;
        save();
      }
    }
    // Whatever the eraser was borrowed from is picked back up on release.
    if (held) { tool = held; held = null; sync(); }
  }

  function up(e) {
    if (!AnnotationModel.ownsPointer(activePointer, e.pointerId)) return;
    var drawn = live || erasing || lasso || moving || resizing || textMoving;
    if (drawn) e.stopPropagation();
    finishGesture();
  }

  /* ---------------------------- scribble to erase ------------------------- */

  // Run on every frame of a stroke rather than only at the end, so the moment
  // it starts to qualify you can see it: the ink it would take fades the way
  // the eraser fades what it is about to rub out, the scribble fades with it
  // (it is about to go too), and the eraser lights up on the panel.
  //
  // The state latches. Once the gesture has been recognised the pen does not
  // become a pen again halfway through, and strokes already marked are not
  // given back — scribble on across more ink and it joins them. What faded is
  // what goes.
  function scribble() {
    scribbleTargets(live.stroke).forEach(function (s) {
      if (marked.indexOf(s) !== -1) return;
      marked.push(s);
      var el = nodes.get(s);
      if (el) el.classList.add('ink-fading');
    });
    if (!marked.length || armed) return;
    armed = true;
    live.trail.fade();
    sync();
  }

  // Cheapest test first, and it is the one that rejects nearly everything: the
  // reversal count looks only at the stroke being drawn, so ordinary
  // handwriting — every letter, every symbol — stops there.
  function scribbleTargets(stroke) {
    var p = simplify(stroke.p, SCRIBBLE.tolerance);
    if (p.length < 3 || reversals(p) < SCRIBBLE.reversals) return [];
    var box = bounds(p);
    return strokes().filter(function (s) {
      // Only ink of the same colour drawn with the same tool: highlighting over
      // pen ink, or annotating a diagram in a second colour, is not erasing it.
      if (s === stroke || s.t !== stroke.t || s.c !== stroke.c) return false;
      if (overlap(box, bounds(s.p)) < SCRIBBLE.overlap) return false;
      // Counted against this stroke alone. A stroke that crosses ten strokes
      // once each has scribbled over none of them.
      return crossings(p, thin(s), SCRIBBLE.crossings) >= SCRIBBLE.crossings;
    });
  }

  // Takes away everything currently marked — by a scribble, or by an eraser
  // drag. The snapshot taken when the gesture began is already the state to
  // come back to, so this deletes without taking another: one undo puts
  // everything back at once.
  function rub() {
    var gone = live ? marked.concat([live.stroke]) : marked;
    ink[slideKey()] = strokes().filter(function (s) { return gone.indexOf(s) === -1; });
    armed = false;
    marked = [];
    render();  // takes the faded paths away along with the strokes they showed
    save();
  }

  /* ---------------------------------- UI --------------------------------- */

  var ICONS = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    pen: '<path d="M4 20l3.6-1L19.3 7.3a1.8 1.8 0 0 0 0-2.5l-1.1-1.1a1.8 1.8 0 0 0-2.5 0L4 15.4z"/><path d="M14.9 5.6l3.5 3.5"/>',
    text: '<path d="M5 5h14M12 5v14M8 19h8"/>',
    highlighter: '<path d="M6.5 14.5l6-9.5 5.5 3.7-6.2 9.8H7.6z"/><path d="M4 21h16"/>',
    eraser: '<path d="M15.6 4.4l4 4a1.6 1.6 0 0 1 0 2.2l-7.5 7.5a1.6 1.6 0 0 1-2.2 0l-4-4a1.6 1.6 0 0 1 0-2.2l7.5-7.5a1.6 1.6 0 0 1 2.2 0z"/><path d="M9 20h11"/>',
    select: '<path d="M5.2 6.4c2.5-3 9.8-3 12.8.2 3.5 3.7.8 9.9-4.7 11.7-5.6 1.8-10.4-1.3-9.1-5.8.8-2.7 4.4-4.2 8.1-3.4" stroke-dasharray="2.5 2.5"/><path d="M16.5 16.5l3.5 3.5"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M16 8V5H5v11h3"/>',
    paste: '<path d="M9 6h6v3H9z"/><path d="M8 7H6v13h12V7h-2"/><path d="M9 13h6M9 17h5"/>',
    continue: '<rect x="3.5" y="5" width="8" height="12" rx="1"/><rect x="13" y="7" width="7.5" height="12" rx="1"/><path d="M8 12h8M13 9l3 3-3 3"/>',
    pressure: '<path d="M4 16c2.2-5.3 4.7-8 7.5-8 3.2 0 5.8 3.3 8.5 10"/><circle cx="11.5" cy="8" r="2.2"/><path d="M4 20h16"/>',
    thinner: '<path d="M5 12h14"/>',
    thicker: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    undo: '<path d="M4.5 9.5h10a4.5 4.5 0 0 1 0 9H9"/><path d="M8 5.5l-4 4 4 4"/>',
    redo: '<path d="M19.5 9.5h-10a4.5 4.5 0 0 0 0 9H15"/><path d="M16 5.5l4 4-4 4"/>',
    clear: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9L17.5 7"/>',
    'delete-page': '<path d="M5 7h14"/><path d="M9 7V4.5h6V7"/><path d="M7 7l1 12h8l1-12"/><path d="M10 10.5v5M14 10.5v5"/>',
    rules: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    download: '<path d="M12 4v11"/><path d="M8 11.5l4 4 4-4"/><path d="M4.5 19.5h15"/>',
    upload: '<path d="M12 15.5v-11"/><path d="M8 8.5l4-4 4 4"/><path d="M4.5 19.5h15"/>',
    print: '<path d="M7.5 9.5V4.5h9v5"/><path d="M7.5 17.5H5.5A1.5 1.5 0 0 1 4 16v-5A1.5 1.5 0 0 1 5.5 9.5h13A1.5 1.5 0 0 1 20 11v5a1.5 1.5 0 0 1-1.5 1.5h-2"/><path d="M7.5 14h9v5.5h-9z"/>',
    more: '<circle cx="6" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1" fill="currentColor" stroke="none"/>',
    fullscreen: '<path d="M4 9V4h5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M9 20H4v-5"/>'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  }

  function button(attr, name, title, iconName) {
    return '<button class="ink-btn" ' + attr + '="' + name + '" title="' + title +
      '" aria-label="' + title + '">' +
      icon(iconName || name) + '</button>';
  }

  function option(attr, name, label, title) {
    return '<button class="ink-option" ' + attr + '="' + name + '" title="' + (title || label) + '">' +
      icon(name) + '<span>' + label + '</span></button>';
  }

  function cycleColour(direction) {
    colour = AnnotationModel.cycleValue(COLOURS.map(function (c) { return c[1]; }), colour, direction);
    sync();
  }

  // A wheel notch chooses the neighbouring colour. Trackpads and Magic Mouse
  // momentum arrive as a burst of wheel events, so rate-limit the burst rather
  // than racing through the whole palette at once. Ctrl-wheel remains the
  // browser's pinch/zoom gesture.
  function wheelColour(e) {
    if (hidden || e.ctrlKey || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    e.stopPropagation();
    var now = Date.now();
    if (now - lastWheel < 220) return;
    lastWheel = now;
    cycleColour(e.deltaY > 0 ? 1 : -1);
  }

  // Expands the element reveal's own F shortcut expands, so the two agree about
  // what "full screen" means; unlike reveal's, this one also comes back out.
  function fullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
      return;
    }
    var view = Reveal.getViewportElement();
    var el = Reveal.getConfig().embedded ? view : view.parentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen ||
      el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req) req.call(el);
  }

  function open(on) {
    if (!on && editing) finishText(true);
    if (tool) lastTool = tool;
    tool = on ? lastTool : null;
    if (!on) moreOpen = false;
    hidden = false;  // the ink comes back with the tools that made it
    sync();
  }

  // Park the ink: the slide as it was written, without the writing on it, for
  // showing the audience the point before the working. Drawing is suspended
  // while it is away — a stroke you cannot see is no use — and V brings back
  // the ink, the panel and the tool that was in hand, all where they were.
  function hide(on) {
    if (on && editing) finishText(true);
    hidden = on;
    if (on) moreOpen = false;
    sync();
  }

  // The colour this tool draws in: the swatch's own, except that the first one
  // is a highlighter's yellow while the highlighter is out.
  // The buttons in the bottom-left corner. A projected screen drops them (see
  // annotate.scss), which is right nearly always -- and "nearly" is what C is
  // for: it puts them back on that screen when it is the only one to hand, and
  // takes them away on a presenting screen when the corner is in the way.
  function showChrome(on) {
    chrome = on;
    document.documentElement.classList.toggle('ink-chrome-on', on);
    document.documentElement.classList.toggle('ink-chrome-off', !on);
  }

  function inkColour() {
    return tool === 'highlighter' && colour === COLOURS[0][1] ? HIGHLIGHT : colour;
  }

  // Redraw the current slide's ink from scratch. The lists are short (a slide
  // holds tens of strokes at most), so there is nothing to be gained by
  // reconciling them; only the in-progress stroke is updated incrementally.
  function render() {
    clearSelection();
    var elements = { pen: [], highlighter: [], text: [] };
    strokes().forEach(function (s) {
      var el = elementFor(s);
      nodes.set(s, el);
      if (elements[s.t]) elements[s.t].push(el);
    });
    Object.keys(layers).forEach(function (t) {
      layers[t].replaceChildren.apply(layers[t], elements[t]);
    });
    live = null;
    sync();
  }

  function clearOverview() {
    document.querySelectorAll('.ink-overview-layer').forEach(function (el) { el.remove(); });
  }

  function overviewLayer(slide, className) {
    var el = document.createElementNS(SVG_NS, 'svg');
    el.setAttribute('class', 'ink-overview-layer ' + className);
    el.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    el.setAttribute('aria-hidden', 'true');
    slide.appendChild(el);
    return el;
  }

  // Overview is a grid of the actual slide sections. Put a small, inert copy
  // of each slide's own ink inside its section so reveal's overview transform
  // scales it along with the page. The live layers stay hidden there because
  // they represent only one slide and would otherwise float over the grid.
  function renderOverview() {
    clearOverview();
    if (!window.Reveal || !Reveal.isOverview || !Reveal.isOverview()) return;
    Reveal.getSlides().forEach(function (slide) {
      var list = ink[slideKeyFor(slide)] || [];
      if (ruled) {
        var guideLayer = overviewLayer(slide, 'ink-overview-rules');
        var guidePath = document.createElementNS(SVG_NS, 'path');
        guidePath.setAttribute('d', rulePathData());
        guideLayer.appendChild(guidePath);
      }
      ['highlighter', 'pen'].forEach(function (t) {
        var drawn = list.filter(function (stroke) { return stroke.t === t; });
        if (!drawn.length) return;
        var layer = overviewLayer(slide, 'ink-overview-' + t);
        drawn.forEach(function (stroke) { layer.appendChild(pathFor(stroke)); });
      });
      var text = list.filter(isText);
      if (text.length) {
        var textLayer = overviewLayer(slide, 'ink-overview-text');
        text.forEach(function (annotation) { textLayer.appendChild(textFor(annotation)); });
      }
    });
  }

  function sync() {
    var key = slideKey(), on = !!tool && !hidden;
    panel.classList.toggle('active', on);
    surface.classList.toggle('drawing', on);
    surface.classList.toggle('ink-text-mode', tool === 'text');
    surface.classList.toggle('ink-text-dragging', !!textMoving && textMoving.moved);
    if (tool !== 'text') surface.classList.remove('ink-text-target');
    Object.keys(layers).forEach(function (t) {
      layers[t].classList.toggle('ink-hidden', hidden);
    });
    guide.classList.toggle('ink-rules-hidden', !ruled);
    selectionLayer.classList.toggle('ink-hidden', hidden || tool !== 'select');
    // A recognised scribble lights the eraser, but only on the panel: the tool
    // itself has to stay the pen, or the stroke being drawn would be cut off.
    var shown = armed ? 'eraser' : tool;
    panel.querySelectorAll('[data-tool]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tool === shown);
    });
    panel.querySelectorAll('[data-colour]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.colour === colour);
    });
    // The first swatch is the one that changes colour with the tool.
    var first = panel.querySelector('[data-colour="' + COLOURS[0][1] + '"]');
    var black = tool !== 'highlighter';
    first.style.color = black ? COLOURS[0][1] : HIGHLIGHT;
    first.title = black ? COLOURS[0][0] : 'Yellow';
    var act = function (name) { return panel.querySelector('[data-act="' + name + '"]'); };
    // The width readout, and the − and + either side of it, belong to the tool
    // in hand; with the eraser out there is nothing for them to step.
    var drawing = !!TOOLS[tool];
    panel.querySelector('.ink-nib text').textContent = drawing ? widths[tool].toFixed(1) : '';
    act('thinner').disabled = !drawing || widths[tool] <= WIDTHS[tool] * NIB.min;
    act('thicker').disabled = !drawing || widths[tool] >= WIDTHS[tool] * NIB.max;
    act('undo').disabled = !(undos[key] || []).length;
    act('redo').disabled = !(redos[key] || []).length;
    act('clear').disabled = !strokes().length;
    act('delete-page').disabled = !window.AnnotatePages || !AnnotatePages.canRemove();
    act('copy').disabled = !selected.length;
    act('paste').disabled = !clipboard || !clipboard.strokes.length;
    act('delete').disabled = !selected.length;
    act('continue').disabled = !selected.length || (!nextSlide() && !window.AnnotatePages);
    act('rules').classList.toggle('active', ruled);
    act('rules-closer').disabled = !ruled || ruleSpacing <= RULES.min;
    act('rules-farther').disabled = !ruled || ruleSpacing >= RULES.max;
    var rulePreview = panel.querySelector('.ink-rule-preview');
    var gap = 4 + (ruleSpacing - RULES.min) / (RULES.max - RULES.min) * 4;
    rulePreview.querySelector('path').setAttribute('d',
      'M8 ' + (11 - gap) + 'H44 M8 11H44 M8 ' + (11 + gap) + 'H44');
    rulePreview.setAttribute('aria-label', 'Rule spacing: ' + ruleSpacing + ' slide units');
    act('pressure').classList.toggle('active', pressureEnabled);
    act('more').classList.toggle('active', moreOpen);
    act('more').setAttribute('aria-expanded', moreOpen ? 'true' : 'false');
    panel.querySelector('.ink-more').hidden = !moreOpen || !on;
    panel.querySelector('.ink-selection-actions').hidden =
      tool !== 'select' || moreOpen || (!selected.length && !clipboard);
  }

  function build() {
    // One layer per tool: the highlighter's has to sit below the pen's so it can
    // multiply with the slide (see annotate.scss).
    //
    // They go *before* the slides, not after: reveal decides it is at the end of
    // the deck by asking whether the current section has a `nextElementSibling`,
    // so a layer appended after the last one leaves reveal (and decktape, which
    // pages through the deck until the end) believing there is always one more
    // slide to come. Nothing in reveal looks at the first child or at previous
    // siblings, and the layers' `z-index` puts them above the slide content
    // regardless of document order.
    slides = document.querySelector('[data-deck-stage]') ||
      document.querySelector('.reveal .slides');
    guide = document.createElementNS(SVG_NS, 'svg');
    guide.setAttribute('class', 'ink-guide');
    guide.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    rulesPath = document.createElementNS(SVG_NS, 'path');
    drawRules();
    guide.appendChild(rulesPath);
    slides.insertBefore(guide, slides.firstChild);

    selectionLayer = document.createElementNS(SVG_NS, 'svg');
    selectionLayer.setAttribute('class', 'ink-selection-layer');
    selectionLayer.setAttribute('viewBox', view.join(' '));
    slides.insertBefore(selectionLayer, slides.firstChild);

    ['highlighter', 'pen', 'text'].forEach(function (t) {
      var el = document.createElementNS(SVG_NS, 'svg');
      el.setAttribute('class', 'ink-layer ink-' + t);
      el.setAttribute('viewBox', view.join(' '));
      slides.insertBefore(el, slides.firstChild);
      layers[t] = el;
    });

    // The layers paint; a plain box over the deck takes the input. It is a
    // <div> rather than the layers themselves because a touch has to land on
    // one, and it hangs off `.reveal` rather than `.slides` because that is
    // where both of the drawing tools that work with a pencil on an iPad put
    // theirs — the chalkboard plugin's canvas and scribble's. Inside `.slides` it
    // would be under an ancestor with `pointer-events: none` and a `perspective`,
    // which is not somewhere a touch is reliably delivered on iPadOS. Nothing
    // is lost by leaving: `at()` measures the pen layer, and `.slides` covers
    // the whole deck anyway.
    surface = document.createElement('div');
    surface.className = 'ink-surface';
    (document.querySelector('[data-deck-stage]') || Reveal.getRevealElement())
      .appendChild(surface);

    // Every listener hangs off the window, in the capture phase, rather than
    // off the surface: on an iPad the surface is never made the target of
    // anything. Logging the deck there showed a pencil's whole stream —
    // `pointerdown`, `pointermove`, `touchstart [stylus]`, `touchmove` — arrive
    // at the window and not one of them reach an element covering the slide,
    // finger taps included. Which element the browser decides was touched is
    // therefore not something to build on; we take the events where they
    // certainly are, and `ours()` decides what they are for.
    //
    // Capturing on the window also puts us ahead of reveal, whose swipe
    // navigation reads the same pointer events, so a stroke can be kept from
    // it by stopping propagation (down(), move() and up() do).
    var input = {
      pointerdown: function (e) { pointers = true; down(e); },
      pointermove: move,
      pointerup: up,
      pointercancel: up,
      touchstart: touchDown,
      touchmove: touchMove,
      touchend: touchUp,
      touchcancel: touchUp
    };
    Object.keys(input).forEach(function (type) {
      window.addEventListener(type, function (e) {
        var handled = ours(e);
        if (!handled) { trace(type, e, false); return; }
        // iPadOS decides for itself what a pencil or a finger on the page
        // means — scroll it, select the text under the tip, start a system
        // gesture — and having decided, it cancels the stream the stroke was
        // being built from. `touch-action: none` is not enough there; the
        // touch events themselves have to be refused, as the scribble deck
        // refuses them on the canvas it hands an Apple Pencil. Non-passive, or
        // the browser is free to ignore the refusal.
        if (type.indexOf('touch') === 0 && e.cancelable) e.preventDefault();
        input[type](e);
        trace(type, e, true);
      }, { capture: true, passive: false });
    });
    window.addEventListener('blur', function (e) {
      if (activePointer !== null) finishGesture();
      trace('blur', e, true);
    }, true);
    window.addEventListener('lostpointercapture', function (e) {
      var handled = AnnotationModel.ownsPointer(activePointer, e.pointerId);
      if (handled) finishGesture();
      trace('lostpointercapture', e, handled);
    }, true);
    window.addEventListener('error', function (e) {
      trace('error', e, true, e.message || 'window error');
    });
    window.addEventListener('unhandledrejection', function (e) {
      trace('unhandledrejection', e, true, String(e.reason || 'unknown rejection'));
    });
    // The right button is the eraser here, so it has no menu to bring up — one
    // would land mid-stroke and interrupt the erase it was part of.
    window.addEventListener('contextmenu', function (e) {
      if (ours(e)) e.preventDefault();
    }, true);
    // Suppress the compatibility click that some browsers send after a wheel
    // button press, and turn wheel motion over the slide into colour changes.
    window.addEventListener('auxclick', function (e) {
      if (e.button === 1 && ours(e)) e.preventDefault();
    }, true);
    window.addEventListener('wheel', function (e) {
      if (ours(e)) wheelColour(e);
    }, { capture: true, passive: false });
    // Safari's own pinch and rotate, which have nothing to do on a slide.
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
      window.addEventListener(type, function (e) { if (tool) e.preventDefault(); }, true);
    });

    panel = document.createElement('div');
    panel.className = 'ink-panel';
    panel.innerHTML =
      COLOURS.map(function (c) {
        return '<button class="ink-swatch" data-colour="' + c[1] + '" style="color:' + c[1] +
          '" title="' + c[0] + '"></button>';
      }).join('') +
      '<hr>' +
      button('data-tool', 'pen', 'Pen') +
      button('data-tool', 'highlighter', 'Highlighter') +
      button('data-tool', 'text', 'Text box') +
      button('data-tool', 'eraser', 'Eraser (whole strokes; or hold the right button)') +
      button('data-tool', 'select', 'Lasso and move') +
      '<hr>' +
      button('data-act', 'undo', 'Undo (⌘Z)') +
      button('data-act', 'redo', 'Redo (⇧⌘Z)') +
      button('data-act', 'more', 'More annotation options') +
      '<div class="ink-selection-actions" role="group" aria-label="Selection actions" hidden>' +
        button('data-act', 'continue', 'Continue on next slide (⌘Enter)') +
        button('data-act', 'copy', 'Copy selection (⌘C)') +
        button('data-act', 'paste', 'Paste copied ink (⌘V)') +
        button('data-act', 'delete', 'Delete selection (Delete)', 'clear') +
      '</div>' +
      '<div class="ink-more" role="group" aria-label="Annotation options" hidden>' +
        '<div class="ink-more-title">Stroke width</div>' +
        '<div class="ink-width-row">' +
          button('data-act', 'thinner', 'Thinner ([)') +
          // The width between them is an SVG so the deck's large body type
          // cannot enlarge it inside this compact control.
          '<svg class="ink-nib" width="52" height="22" viewBox="0 0 52 22" fill="currentColor" ' +
          'opacity="0.65"><title>How wide the tool in hand draws, in slide units</title>' +
          '<text x="26" y="16" text-anchor="middle" font-size="13"></text></svg>' +
          button('data-act', 'thicker', 'Thicker (])') +
        '</div>' +
        '<hr>' +
        option('data-act', 'rules', 'Ruled writing guides', 'Show/hide ruled writing guides (l)') +
        '<div class="ink-more-title ink-rule-title">Rule spacing</div>' +
        '<div class="ink-rule-row">' +
          button('data-act', 'rules-closer', 'Move ruled lines closer together', 'thinner') +
          '<svg class="ink-rule-preview" width="52" height="22" viewBox="0 0 52 22" ' +
          'fill="none" stroke="currentColor" stroke-width="1.5" role="img"><path/></svg>' +
          button('data-act', 'rules-farther', 'Move ruled lines farther apart', 'thicker') +
        '</div>' +
        option('data-act', 'pressure', 'Pencil pressure', 'Apple Pencil pressure changes stroke width') +
        '<hr>' +
        option('data-act', 'clear', 'Clear this slide', 'Clear this slide (⇧ for the whole deck)') +
        option('data-act', 'delete-page', 'Delete this page') +
        option('data-act', 'print', 'Download annotated PDF') +
        option('data-act', 'download', 'Export annotations') +
        option('data-act', 'upload', 'Import annotations') +
      '</div>';

    // The file to load is chosen with an input the panel keeps out of sight;
    // its button clicks it.
    picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'application/json,.json';
    picker.style.display = 'none';
    picker.addEventListener('change', function () {
      if (picker.files[0]) upload(picker.files[0]);
      picker.value = '';  // so the same file can be loaded twice
    });
    panel.appendChild(picker);

    var full = document.createElement('button');
    full.className = 'ink-toggle';
    full.title = 'Full screen (f)';
    full.innerHTML = icon('fullscreen');
    full.addEventListener('click', fullscreen);

    var launchers = document.createElement('div');
    launchers.className = 'ink-launchers';
    // Sit clear of the menu plugin's button, which shares this corner.
    if (document.querySelector('.slide-menu-button')) launchers.classList.add('ink-offset');
    launchers.appendChild(full);

    var parent = document.querySelector('[data-deck-stage]') || Reveal.getRevealElement();
    parent.appendChild(panel);
    parent.appendChild(launchers);

    panel.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tool],[data-act],[data-colour]');
      if (!b) return;
      if (b.dataset.colour) {
        colour = b.dataset.colour;
        if (tool === 'eraser') tool = lastTool = 'pen';  // a colour implies drawing
      } else if (b.dataset.tool) {
        if (activePointer !== null) finishGesture();
        if (tool === 'select' && b.dataset.tool !== 'select') clearSelection();
        tool = b.dataset.tool;
        if (tool === 'select') moreOpen = false;
        trace('toolchange', e, true, tool);
      } else if (b.dataset.act === 'close') {
        return open(false);
      } else if (b.dataset.act === 'thinner' || b.dataset.act === 'thicker') {
        resize(b.dataset.act === 'thicker');
      } else if (b.dataset.act === 'undo') {
        step(undos, redos);
      } else if (b.dataset.act === 'redo') {
        step(redos, undos);
      } else if (b.dataset.act === 'continue') {
        continueSelection();
      } else if (b.dataset.act === 'copy') {
        copySelection();
      } else if (b.dataset.act === 'paste') {
        pasteSelection();
      } else if (b.dataset.act === 'delete') {
        deleteSelection();
      } else if (b.dataset.act === 'clear') {
        clear(e.shiftKey);
      } else if (b.dataset.act === 'delete-page') {
        deletePage();
      } else if (b.dataset.act === 'rules') {
        toggleRules();
      } else if (b.dataset.act === 'rules-closer' || b.dataset.act === 'rules-farther') {
        resizeRules(b.dataset.act === 'rules-farther');
      } else if (b.dataset.act === 'pressure') {
        togglePressure();
      } else if (b.dataset.act === 'more') {
        moreOpen = !moreOpen;
      } else if (b.dataset.act === 'download') {
        download();
      } else if (b.dataset.act === 'print') {
        downloadPdf();
      } else if (b.dataset.act === 'upload') {
        picker.click();
      }
      sync();
    });
  }

  /* ------------------------------- start-up ------------------------------ */

  function init() {
    var size = pageSize();
    W = size[0];
    H = size[1];
    view = [-OVERSCAN * W, -OVERSCAN * H, (1 + 2 * OVERSCAN) * W, (1 + 2 * OVERSCAN) * H];
    build();
    render();
    showChrome(chrome);

    Reveal.on('slidechanged', function () {
      if (editing) finishText(true);
      render();
      if (Reveal.isOverview()) renderOverview();
    });
    Reveal.on('overviewshown', function () {
      open(false);
      renderOverview();
    });
    Reveal.on('overviewhidden', function () {
      clearOverview();
      open(true);
    });
    // Quarto's support plugin binds R to its scroll view and lets reveal fall
    // into it on a narrow viewport; both break a fixed stage you write on.
    Reveal.removeKeyBinding(82);
    Reveal.configure({ scrollActivationWidth: null });

    Reveal.addKeyBinding(
      { keyCode: 86, key: 'V', description: 'Hide/show the annotations' },
      function () { hide(!hidden); }
    );
    Reveal.addKeyBinding(
      { keyCode: 82, key: 'R', description: 'Show/hide ruled writing guides' },
      toggleRules
    );
    Reveal.addKeyBinding(
      { keyCode: 67, key: 'C', description: 'Show/hide the corner buttons' },
      function () { showChrome(!chrome); }
    );

    // Capture the annotation shortcuts before reveal sees them.
    document.addEventListener('keydown', function (e) {
      if (!tool) return;
      if (e.key === 'Escape' && moreOpen) {
        moreOpen = false;
        sync();
      } else if (e.key === 'Escape' && selected.length) {
        clearSelection();
        sync();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.shiftKey ? step(redos, undos) : step(undos, redos);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && selected.length) {
        copySelection();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && clipboard) {
        pasteSelection();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selected.length && nextSlide()) {
        continueSelection();
      } else if (tool === 'select' && selected.length &&
                 (e.key === 'Delete' || e.key === 'Backspace')) {
        deleteSelection();
      } else if ((e.key === '[' || e.key === ']') && TOOLS[tool]) {
        resize(e.key === ']');
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  // This runs from include-after-body, which may be before reveal has finished
  // initialising; wait for it, as the other fixes in this deck do.
  function ready() {
    if (!window.Reveal || !Reveal.isReady || !Reveal.isReady()) return false;
    if (PRINT) {
      if (PRINT_INK) printInk();
    } else {
      init();
    }
    return true;
  }
  if (!ready()) {
    var iv = setInterval(function () { if (ready()) clearInterval(iv); }, 50);
    setTimeout(function () { clearInterval(iv); }, 10000);
  }
})();
