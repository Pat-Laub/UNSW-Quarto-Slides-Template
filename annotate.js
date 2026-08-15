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
// Styling — and why there is a layer per tool — is in custom.scss.
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

  var ERASER = 10;      // eraser hit radius, in slide coordinates
  var UNDO_DEPTH = 40;  // snapshots kept per slide

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
  var colour = COLOURS[0][1];
  var live = null;           // { stroke, el } while a stroke is being drawn
  var erasing = false;       // an eraser drag is in progress
  var armed = false;         // the live stroke has been recognised as a scribble
  var marked = [];           // strokes the eraser or scribble takes when let go
  var nodes = new WeakMap(); // stroke -> its <path>, for the fade preview
  var thinned = new WeakMap();// stroke -> its simplified points
  var layers = {};           // one SVG per drawing tool; see build()
  var W, H, svg, panel, toggle, saveTimer;

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
  // redo branch we are about to diverge from.
  function snapshot() {
    var key = slideKey();
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

  function clear() {
    if (!strokes().length) return;
    snapshot();
    ink[slideKey()] = [];
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
      var out = {};
      Object.keys(ink).forEach(function (k) { if (ink[k].length) out[k] = ink[k]; });
      try { localStorage.setItem(STORE, JSON.stringify(out)); } catch (e) { /* full or blocked */ }
    }, 400);
  }

  /* ------------------------------- drawing ------------------------------- */

  // Map a pointer event onto slide coordinates. Going through the rendered box
  // keeps this correct under reveal's slide scaling and the zoom plugin's
  // transform alike, and rounding keeps the stored JSON small.
  function at(e) {
    var r = svg.getBoundingClientRect();
    return [
      Math.round((e.clientX - r.left) / r.width * W * 10) / 10,
      Math.round((e.clientY - r.top) / r.height * H * 10) / 10,
      Math.round(e.pressure * 100) / 100
    ];
  }

  // Pointer events are delivered at most once per frame, but the browser keeps
  // the finer samples it coalesced into each one; using them smooths fast strokes.
  function points(e) {
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    return (evs && evs.length ? evs : [e]).map(at);
  }

  function down(e) {
    if (!tool || e.button) return;  // ignore right/middle clicks
    e.preventDefault();
    e.stopPropagation();            // keep reveal from reading the drag as a swipe
    svg.setPointerCapture(e.pointerId);
    var p = at(e);
    if (tool === 'eraser') { erasing = true; marked = []; erase(p[0], p[1]); return; }
    snapshot();
    var stroke = { t: tool, c: colour, s: e.pointerType !== 'pen', p: [p] };
    (ink[slideKey()] = ink[slideKey()] || []).push(stroke);
    live = { stroke: stroke, el: pathFor(stroke, true) };
    nodes.set(stroke, live.el);
    layers[tool].appendChild(live.el);
    armed = false;
    marked = [];
    sync();
  }

  function move(e) {
    if (!tool) return;
    if (erasing) { points(e).forEach(function (p) { erase(p[0], p[1]); }); return; }
    if (!live) return;
    live.stroke.p = live.stroke.p.concat(points(e));
    live.el.setAttribute('d', pathData(live.stroke, true));
    scribble();
  }

  function up() {
    if (erasing) {
      erasing = false;
      if (marked.length) rub();
      return;
    }
    if (!live) return;
    if (marked.length) return rub();
    live.el.setAttribute('d', pathData(live.stroke));  // close off the tapered end
    live = null;
    save();
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
    sync();
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
    var key = slideKey(), on = !!tool;
    panel.classList.toggle('active', on);
    toggle.classList.toggle('active', on);
    svg.classList.toggle('drawing', on);
    // A recognised scribble lights the eraser, but only on the panel: the tool
    // itself has to stay the pen, or the stroke being drawn would be cut off.
    var shown = armed ? 'eraser' : tool;
    panel.querySelectorAll('[data-tool]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tool === shown);
    });
    panel.querySelectorAll('[data-colour]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.colour === colour);
    });
    var act = function (name) { return panel.querySelector('[data-act="' + name + '"]'); };
    act('undo').disabled = !(undos[key] || []).length;
    act('redo').disabled = !(redos[key] || []).length;
    act('clear').disabled = !strokes().length;
  }

  function build() {
    // One layer per tool: the highlighter's has to sit below the pen's so it can
    // multiply with the slide (see custom.scss). The pen's is topmost, so it is
    // the one that takes the pointer input, whichever tool is selected.
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
      el.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      slides.insertBefore(el, slides.firstChild);
      layers[t] = el;
    });
    svg = layers.pen;

    svg.addEventListener('pointerdown', down);
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    // Reveal reads touch drags on its root element as swipe navigation; while a
    // tool is active the drag is a stroke, so keep those events to ourselves.
    ['touchstart', 'touchmove'].forEach(function (type) {
      svg.addEventListener(type, function (e) { if (tool) e.stopPropagation(); });
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
      button('data-tool', 'eraser', 'Eraser (erases whole strokes)') +
      '<hr>' +
      button('data-act', 'undo', 'Undo (⌘Z)') +
      button('data-act', 'redo', 'Redo (⇧⌘Z)') +
      button('data-act', 'clear', 'Clear this slide');

    toggle = document.createElement('button');
    toggle.className = 'ink-toggle';
    toggle.title = 'Annotate (d)';
    toggle.innerHTML = icon('pen');
    toggle.addEventListener('click', function () { open(!tool); });

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
        clear();
      }
      sync();
    });
  }

  /* ------------------------------- start-up ------------------------------ */

  function init() {
    var cfg = Reveal.getConfig();
    W = parseFloat(cfg.width) || 960;
    H = parseFloat(cfg.height) || 700;
    build();
    render();

    Reveal.on('slidechanged', render);
    Reveal.on('overviewshown', function () { open(false); });  // one layer, one slide
    Reveal.addKeyBinding(
      { keyCode: 68, key: 'D', description: 'Toggle drawing tools' },
      function () { open(!tool); }
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
