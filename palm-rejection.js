// Keep reveal.js from confusing two separate palm contacts for one swipe.
//
// Reveal converts every touch pointer into a one-item `touches` array and does
// not retain the pointer id. A second contact can therefore replace the start
// point of the first, after which movement from either contact looks like a
// large swipe. This capture-phase guard lets genuine one-finger gestures pass
// through unchanged, but quarantines a gesture as soon as it has two contacts.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.RevealPalmRejection = api;
    api.attach(root);
  }
})(typeof window !== 'undefined' ? window : this, function () {
  function createGuard() {
    var active = new Set();
    var rejected = false;

    return function block(type, e) {
      if (e.pointerType !== 'touch') return false;

      if (type === 'pointerdown') {
        active.add(e.pointerId);
        if (active.size > 1) rejected = true;
      }

      var blocked = rejected && active.has(e.pointerId);

      if (type === 'pointerup' || type === 'pointercancel') {
        active.delete(e.pointerId);
        if (!active.size) rejected = false;
      }

      return blocked;
    };
  }

  function attach(target) {
    if (!target || !target.addEventListener) return;
    var block = createGuard();
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (type) {
      target.addEventListener(type, function (e) {
        if (!block(type, e)) return;
        if (e.cancelable) e.preventDefault();
        // Capture on window keeps the event from reaching reveal's listener on
        // `.reveal`. Other capture listeners on window may still clean up.
        e.stopPropagation();
      }, { capture: true, passive: false });
    });
  }

  return { createGuard: createGuard, attach: attach };
});
