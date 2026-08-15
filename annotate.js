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

  // perfect-freehand options per tool, in slide coordinates. `thinning` is how
  // much pressure narrows the line: the pen tapers like a real nib, while the
  // highlighter is a constant-width chisel.
  var TOOLS = {
    pen: { size: 5, thinning: 0.6, smoothing: 0.5, streamline: 0.45 },
    highlighter: { size: 28, thinning: 0, smoothing: 0.6, streamline: 0.55 }
  };

  // Black ink is black, but a black *highlighter* is a grey smear over the
  // words it is meant to pick out. The first swatch draws — and shows itself
  // as — the colour a highlighter actually is while that tool is in hand.
  var HIGHLIGHT = '#facc15';

  var ERASER = 10;      // eraser hit radius, in slide coordinates
  var UNDO_DEPTH = 40;  // snapshots kept per slide

  // How far each layer reaches beyond the slide, as a multiple of the deck's
  // size. The slide is letterboxed inside the window, and content sits flush
  // against its edges: a stroke started a pixel to the left of a paragraph would
  // otherwise miss the layer entirely and land on reveal's background, where the
  // browser reads the drag as selecting text. Overscanning covers the letterbox,
  // so the pointer meets ink wherever it goes down. Kept in step with the
  // layers' negative `inset` in annotate.scss.
  var OVERSCAN = 1;

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

  /* -------------------------------- state -------------------------------- */

  // A stroke is { t: tool, c: colour, s: simulate-pressure, p: [[x, y, pressure], ...] }.
  var ink = read();          // { slideKey: [stroke, ...] }
  var undos = {}, redos = {};// { slideKey: [JSON snapshot, ...] }
  var tool = null;           // active tool; null exactly when the panel is closed
  var lastTool = 'pen';      // restored when the panel is reopened
  var hidden = false;        // the ink is parked, showing the slide underneath
  var colour = COLOURS[0][1];
  var live = null;           // { stroke, el } while a stroke is being drawn
  var erasing = false;       // an eraser drag is in progress
  var held = null;           // the tool the right button borrowed the eraser from
  var armed = false;         // the live stroke has been recognised as a scribble
  var marked = [];           // strokes the eraser or scribble takes when let go
  var nodes = new WeakMap(); // stroke -> its <path>, for the fade preview
  var thinned = new WeakMap();// stroke -> its simplified points
  var layers = {};           // one SVG per drawing tool; see build()
  var view;                  // every layer's viewBox, in slide coordinates
  var pen = false;           // a pen has been used, so fingers are not ink
  var hovers = 0;            // consecutive hovering mouse moves; see hover()
  var W, H, surface, panel, picker, toggle, saveTimer;

  /* ------------------------------ stroke maths --------------------------- */

  // perfect-freehand returns the stroke's outline as a polygon; draw it as a
  // path of quadratic curves through the midpoints, which rounds the corners.
  function pathData(stroke, unfinished) {
    var o = TOOLS[stroke.t];
    var pts = getStroke(stroke.p, {
      size: o.size, thinning: o.thinning, smoothing: o.smoothing,
      streamline: o.streamline, simulatePressure: stroke.s, last: !unfinished
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

  // Distance from (x, y) to the segment a–b: erasing tests segments, not just
  // points, so a fast (and therefore sparsely sampled) stroke is still hit.
  function segDist(x, y, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    var t = len ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len)) : 0;
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  }

  function touches(stroke, x, y) {
    var r = ERASER + TOOLS[stroke.t].size / 2, p = stroke.p;
    for (var i = 0; i < p.length; i++) {
      if (segDist(x, y, p[i], p[i + 1] || p[i]) <= r) return true;
    }
    return false;
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

  function slideKey() {
    var s = Reveal.getCurrentSlide();
    if (!s) return '0.0';
    var i = Reveal.getIndices(s);
    return s.id || i.h + '.' + i.v;
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

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(STORE, JSON.stringify(kept())); } catch (e) { /* full or blocked */ }
    }, 400);
  }

  function kept() {
    var out = {};
    Object.keys(ink).forEach(function (k) { if (ink[k].length) out[k] = ink[k]; });
    return out;
  }

  // localStorage is this browser on this machine: the ink does not follow the
  // deck to another device, and clearing site data takes it. These two put a
  // whole deck's ink in a file and read one back — the file is the same JSON
  // that is stored, keyed by slide, so it lands back on the slides it was
  // drawn on.
  function download() {
    var name = (location.pathname.split('/').pop() || 'slides').replace(/\.html?$/, '');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(kept())], { type: 'application/json' }));
    a.download = name + '-ink.json';
    panel.appendChild(a);  // not every browser follows a link that isn't in the page
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function upload(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (e) { return; }
      if (!data || typeof data !== 'object') return;
      ink = data;
      undos = {};  // the ink these described is not the ink that is here now
      redos = {};
      render();
      save();
    };
    reader.readAsText(file);
  }

  /* ------------------------------- drawing ------------------------------- */

  // Map a pointer event onto slide coordinates. Going through the rendered box
  // keeps this correct under reveal's slide scaling and the zoom plugin's
  // transform alike, and rounding keeps the stored JSON small. The box is the
  // overscanned layer rather than the slide, so a point outside the slide maps
  // outside [0, W] x [0, H] — which is what it is.
  function at(e) {
    var r = surface.getBoundingClientRect();
    return [
      Math.round((view[0] + (e.clientX - r.left) / r.width * view[2]) * 10) / 10,
      Math.round((view[1] + (e.clientY - r.top) / r.height * view[3]) * 10) / 10,
      Math.round(e.pressure * 100) / 100
    ];
  }

  // Pointer events are delivered at most once per frame, but the browser keeps
  // the finer samples it coalesced into each one; using them smooths fast strokes.
  function points(e) {
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    return (evs && evs.length ? evs : [e]).map(at);
  }

  // The modifier reveal's zoom plugin magnifies on (ctrl on Linux, otherwise
  // alt), honouring an explicit `zoomKey`; the same one the arrow-key panning
  // in reveal-fixes.html looks for.
  function zoomModifier() {
    var cfg = Reveal.getConfig();
    return ((cfg && cfg.zoomKey) || (/Linux/.test(navigator.platform) ? 'ctrl' : 'alt')) + 'Key';
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
    // Hold the right button — or the barrel button a stylus reports as one, or
    // the inverted end of a pen, which is button 5 — and it erases for as long
    // as it is held: scribble over what is to go, let go, and the tool that was
    // in hand comes back. Erasing is already two steps (what the drag passes
    // over fades, and goes when the drag ends), so a slip costs nothing.
    var borrowed = e.button === 2 || e.button === 5;
    if (e.button && !borrowed) return;      // middle click, and anything else
    if (borrowed && (live || erasing)) return;  // a stroke is already in progress
    e.preventDefault();
    e.stopPropagation();            // keep reveal from reading the drag as a swipe
    unhover();                      // nothing to point with while the tip is down
    // A stroke survives the pointer leaving the surface; nothing else in the
    // deck wants the events, so carrying on without capture is no worse.
    try { surface.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    if (borrowed) { held = tool; tool = 'eraser'; }
    var p = at(e);
    if (tool === 'eraser') { erasing = true; marked = []; erase(p[0], p[1]); sync(); return; }
    snapshot();
    var stroke = { t: tool, c: inkColour(), s: e.pointerType !== 'pen', p: [p] };
    (ink[slideKey()] = ink[slideKey()] || []).push(stroke);
    live = { stroke: stroke, el: pathFor(stroke, true) };
    nodes.set(stroke, live.el);
    layers[tool].appendChild(live.el);
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
    if (e.pointerType !== 'mouse' || e.buttons || hovers >= 2) return;
    if (++hovers === 2) surface.classList.add('ink-hover');
  }

  function unhover() {
    hovers = 0;
    surface.classList.remove('ink-hover');
  }

  function move(e) {
    hover(e);
    if (!live && !erasing) return;
    // Reveal navigates on a pointer drag as well as on a touch swipe, and it
    // reads every move, not just the ones that follow a pointerdown it saw. A
    // stroke is not a swipe, so the moves that make it up stop here.
    e.stopPropagation();
    if (erasing) { points(e).forEach(function (p) { erase(p[0], p[1]); }); return; }
    live.stroke.p = live.stroke.p.concat(points(e));
    live.el.setAttribute('d', pathData(live.stroke, true));
    scribble();
  }

  function up(e) {
    var drawn = live || erasing;
    if (drawn) e.stopPropagation();
    unhover();  // a lifted pen leaves no cursor behind; a mouse moves on
    if (erasing) {
      erasing = false;
      if (marked.length) rub();
    } else if (live) {
      if (marked.length) {
        rub();
      } else {
        live.el.setAttribute('d', pathData(live.stroke));  // close off the tapered end
        live = null;
        save();
      }
    }
    // Whatever the eraser was borrowed from is picked back up on release.
    if (held) { tool = held; held = null; sync(); }
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
    live.el.classList.add('ink-fading');
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
    highlighter: '<path d="M6.5 14.5l6-9.5 5.5 3.7-6.2 9.8H7.6z"/><path d="M4 21h16"/>',
    eraser: '<path d="M15.6 4.4l4 4a1.6 1.6 0 0 1 0 2.2l-7.5 7.5a1.6 1.6 0 0 1-2.2 0l-4-4a1.6 1.6 0 0 1 0-2.2l7.5-7.5a1.6 1.6 0 0 1 2.2 0z"/><path d="M9 20h11"/>',
    undo: '<path d="M4.5 9.5h10a4.5 4.5 0 0 1 0 9H9"/><path d="M8 5.5l-4 4 4 4"/>',
    redo: '<path d="M19.5 9.5h-10a4.5 4.5 0 0 0 0 9H15"/><path d="M16 5.5l4 4-4 4"/>',
    clear: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9L17.5 7"/>',
    download: '<path d="M12 4v11"/><path d="M8 11.5l4 4 4-4"/><path d="M4.5 19.5h15"/>',
    upload: '<path d="M12 15.5v-11"/><path d="M8 8.5l4-4 4 4"/><path d="M4.5 19.5h15"/>',
    fullscreen: '<path d="M4 9V4h5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M9 20H4v-5"/>'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  }

  function button(attr, name, title) {
    return '<button class="ink-btn" ' + attr + '="' + name + '" title="' + title + '">' +
      icon(name) + '</button>';
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
    if (tool) lastTool = tool;
    tool = on ? lastTool : null;
    hidden = false;  // the ink comes back with the tools that made it
    sync();
  }

  // Park the ink: the slide as it was written, without the writing on it, for
  // showing the audience the point before the working. Drawing is suspended
  // while it is away — a stroke you cannot see is no use — and V brings back
  // the ink, the panel and the tool that was in hand, all where they were.
  function hide(on) {
    hidden = on;
    sync();
  }

  // The colour this tool draws in: the swatch's own, except that the first one
  // is a highlighter's yellow while the highlighter is out.
  function inkColour() {
    return tool === 'highlighter' && colour === COLOURS[0][1] ? HIGHLIGHT : colour;
  }

  // Redraw the current slide's ink from scratch. The lists are short (a slide
  // holds tens of strokes at most), so there is nothing to be gained by
  // reconciling them; only the in-progress stroke is updated incrementally.
  function render() {
    var paths = { pen: [], highlighter: [] };
    strokes().forEach(function (s) {
      var el = pathFor(s);
      nodes.set(s, el);  // so a scribble can fade the strokes it is taking
      paths[s.t].push(el);
    });
    Object.keys(layers).forEach(function (t) {
      layers[t].replaceChildren.apply(layers[t], paths[t]);
    });
    live = null;
    sync();
  }

  function sync() {
    var key = slideKey(), on = !!tool && !hidden;
    panel.classList.toggle('active', on);
    toggle.classList.toggle('active', on);
    surface.classList.toggle('drawing', on);
    Object.keys(layers).forEach(function (t) {
      layers[t].classList.toggle('ink-hidden', hidden);
    });
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
    act('undo').disabled = !(undos[key] || []).length;
    act('redo').disabled = !(redos[key] || []).length;
    act('clear').disabled = !strokes().length;
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
    var slides = document.querySelector('.reveal .slides');
    ['highlighter', 'pen'].forEach(function (t) {
      var el = document.createElementNS(SVG_NS, 'svg');
      el.setAttribute('class', 'ink-layer ink-' + t);
      el.setAttribute('viewBox', view.join(' '));
      slides.insertBefore(el, slides.firstChild);
      layers[t] = el;
    });

    // The layers paint; a plain box over them takes the input. That box is an
    // ordinary <div> because a touch has to land on one: WebKit does not apply
    // `touch-action` to an <svg>, so on an iPad the browser claimed every
    // stylus and finger drag on the layer as a scroll or a text selection and
    // cancelled the stroke before it had started. A div with `touch-action:
    // none` is the path every drawing surface on the web takes. It is laid out
    // exactly like the layers, so `at()` maps a point on it into slide
    // coordinates the same way, and its z-index puts it above both of them.
    surface = document.createElement('div');
    surface.className = 'ink-surface';
    slides.insertBefore(surface, slides.firstChild);

    surface.addEventListener('pointerdown', down);
    surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerup', up);
    surface.addEventListener('pointercancel', up);
    // The right button is the eraser here, so it has no menu to bring up — one
    // would land mid-stroke and interrupt the erase it was part of.
    surface.addEventListener('contextmenu', function (e) { if (tool) e.preventDefault(); });
    // iPadOS decides for itself what a pencil or a finger on the page means —
    // scroll it, select the text under the tip, start a system gesture — and
    // having decided, it cancels the pointer stream the stroke was being built
    // from, so nothing is drawn at all. `touch-action: none` is not enough
    // there: the touch events themselves have to be refused, which is what
    // tldraw does on the canvas it hands an Apple Pencil. Registered
    // non-passive, or the browser is free to ignore the refusal.
    //
    // Pointer events are dispatched ahead of touch events and are not
    // suppressed by this, so reveal still gets to read a finger as a swipe
    // (see down(), which leaves those alone once a pen has been used).
    ['touchstart', 'touchmove', 'touchend'].forEach(function (type) {
      surface.addEventListener(type, function (e) {
        if (!tool) return;
        if (live || erasing) e.stopPropagation();
        if (e.cancelable) e.preventDefault();
      }, { passive: false });
    });
    // Safari's own pinch and rotate, which have nothing to do on a slide.
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
      surface.addEventListener(type, function (e) { if (tool) e.preventDefault(); });
    });

    panel = document.createElement('div');
    panel.className = 'ink-panel';
    panel.innerHTML =
      button('data-act', 'close', 'Close (Esc)') +
      COLOURS.map(function (c) {
        return '<button class="ink-swatch" data-colour="' + c[1] + '" style="color:' + c[1] +
          '" title="' + c[0] + '"></button>';
      }).join('') +
      '<hr>' +
      button('data-tool', 'pen', 'Pen') +
      button('data-tool', 'highlighter', 'Highlighter') +
      button('data-tool', 'eraser', 'Eraser (whole strokes; or hold the right button)') +
      '<hr>' +
      button('data-act', 'undo', 'Undo (⌘Z)') +
      button('data-act', 'redo', 'Redo (⇧⌘Z)') +
      button('data-act', 'clear', 'Clear this slide (⇧ for the whole deck)') +
      '<hr>' +
      button('data-act', 'download', 'Save the deck’s annotations to a file') +
      button('data-act', 'upload', 'Load annotations from a file');

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

    toggle = document.createElement('button');
    toggle.className = 'ink-toggle ink-pen';
    toggle.title = 'Annotate (d), hide the ink (v)';
    toggle.innerHTML = icon('pen');
    toggle.addEventListener('click', function () {
      if (hidden) return hide(false);  // parked ink comes back before anything else
      open(!tool);
    });

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
    launchers.appendChild(toggle);

    var parent = Reveal.getRevealElement();
    parent.appendChild(panel);
    parent.appendChild(launchers);

    panel.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tool],[data-act],[data-colour]');
      if (!b) return;
      if (b.dataset.colour) {
        colour = b.dataset.colour;
        if (tool === 'eraser') tool = lastTool = 'pen';  // a colour implies drawing
      } else if (b.dataset.tool) {
        tool = b.dataset.tool;
      } else if (b.dataset.act === 'close') {
        return open(false);
      } else if (b.dataset.act === 'undo') {
        step(undos, redos);
      } else if (b.dataset.act === 'redo') {
        step(redos, undos);
      } else if (b.dataset.act === 'clear') {
        clear(e.shiftKey);
      } else if (b.dataset.act === 'download') {
        download();
      } else if (b.dataset.act === 'upload') {
        picker.click();
      }
      sync();
    });
  }

  /* ------------------------------- start-up ------------------------------ */

  function init() {
    var cfg = Reveal.getConfig();
    W = parseFloat(cfg.width) || 960;
    H = parseFloat(cfg.height) || 700;
    view = [-OVERSCAN * W, -OVERSCAN * H, (1 + 2 * OVERSCAN) * W, (1 + 2 * OVERSCAN) * H];
    build();
    render();

    Reveal.on('slidechanged', render);
    Reveal.on('overviewshown', function () { open(false); });  // one layer, one slide
    Reveal.addKeyBinding(
      { keyCode: 68, key: 'D', description: 'Toggle drawing tools' },
      function () { open(!tool); }
    );
    Reveal.addKeyBinding(
      { keyCode: 86, key: 'V', description: 'Hide/show the annotations' },
      function () { hide(!hidden); }
    );

    // Capture phase, so Escape closes the panel instead of opening the overview.
    document.addEventListener('keydown', function (e) {
      if (!tool) return;
      if (e.key === 'Escape') {
        open(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.shiftKey ? step(redos, undos) : step(undos, redos);
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
    init();
    return true;
  }
  if (!ready()) {
    var iv = setInterval(function () { if (ready()) clearInterval(iv); }, 50);
    setTimeout(function () { clearInterval(iv); }, 10000);
  }
})();
