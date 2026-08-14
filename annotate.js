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
//     and drop it, rather than scrubbing pixels;
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
  var erased = false;        // ... and it has already removed something
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

  function erase(x, y) {
    var key = slideKey(), before = ink[key] || [];
    var after = before.filter(function (s) { return !touches(s, x, y); });
    if (after.length === before.length) return;
    if (!erased) snapshot();  // one undo entry per eraser drag, not per stroke
    erased = true;
    ink[key] = after;
    render();
    save();
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
    if (tool === 'eraser') { erasing = true; erased = false; erase(p[0], p[1]); return; }
    snapshot();
    var stroke = { t: tool, c: colour, s: e.pointerType !== 'pen', p: [p] };
    (ink[slideKey()] = ink[slideKey()] || []).push(stroke);
    live = { stroke: stroke, el: pathFor(stroke, true) };
    layers[tool].appendChild(live.el);
    sync();
  }

  function move(e) {
    if (!tool) return;
    if (erasing) { points(e).forEach(function (p) { erase(p[0], p[1]); }); return; }
    if (!live) return;
    live.stroke.p = live.stroke.p.concat(points(e));
    live.el.setAttribute('d', pathData(live.stroke, true));
  }

  function up() {
    erasing = false;
    if (!live) return;
    live.el.setAttribute('d', pathData(live.stroke));  // close off the tapered end
    live = null;
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
    clear: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9L17.5 7"/>'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  }

  function button(attr, name, title) {
    return '<button class="ink-btn" ' + attr + '="' + name + '" title="' + title + '">' +
      icon(name) + '</button>';
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
    strokes().forEach(function (s) { paths[s.t].push(pathFor(s)); });
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
    panel.querySelectorAll('[data-tool]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tool === tool);
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
    // Sit clear of the menu plugin's button, which shares this corner.
    if (document.querySelector('.slide-menu-button')) toggle.classList.add('ink-offset');
    toggle.addEventListener('click', function () { open(!tool); });

    var parent = Reveal.getRevealElement();
    parent.appendChild(panel);
    parent.appendChild(toggle);

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
