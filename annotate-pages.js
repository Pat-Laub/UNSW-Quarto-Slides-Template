// A reveal.js deck that grows one blank page at a time.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.AnnotatePages = api;

  // Growing the deck a page at a time is what a blank pad is for and exactly
  // wrong in a lecture deck, where navigating past the last slide should do
  // nothing. It is therefore opt-in -- `annotate: {pages: true}` -- and the
  // option only exists once Reveal has been configured, so wait for it the way
  // annotate.js does rather than reading at load time.
  function start() {
    if (!root.Reveal || !root.Reveal.isReady || !root.Reveal.isReady()) return false;
    var cfg = root.Reveal.getConfig ? root.Reveal.getConfig() : null;
    var opts = cfg && cfg.annotate;
    if (opts && opts.pages) api.install(root);
    return true;
  }
  if (!start()) {
    var iv = setInterval(function () { if (start()) clearInterval(iv); }, 50);
    setTimeout(function () { clearInterval(iv); }, 10000);
  }
})(typeof window !== 'undefined' ? window : null, function () {
  var PREFIX = 'scribble-slide-';
  var MAX_PAGES = 5000;
  var runtime = null;

  function pageId(number) {
    number = Math.max(1, Math.min(MAX_PAGES, Math.floor(Number(number) || 1)));
    return PREFIX + String(number).padStart(3, '0');
  }

  function pageNumber(value) {
    var match = String(value || '').match(/scribble-slide-(\d+)/);
    return match ? Math.max(1, Math.min(MAX_PAGES, Number(match[1]))) : 0;
  }

  function normalisePageIds(values) {
    var ids = [], seen = {};
    Array.from(values || []).forEach(function (value) {
      var number = pageNumber(value);
      var id = number && pageId(number);
      if (id && !seen[id]) { seen[id] = true; ids.push(id); }
    });
    return ids.length ? ids : [pageId(1)];
  }

  function requiredPageCount(keys) {
    return Array.from(keys || []).reduce(function (count, key) {
      return Math.max(count, pageNumber(key));
    }, 1);
  }

  function install(win) {
    if (runtime) return runtime;
    var doc = win.document;
    var slides = doc.querySelector('.reveal .slides');
    if (!slides) return null;
    var countStore = 'scribble-page-count-v1:' + win.location.pathname;
    var idsStore = 'scribble-page-ids-v2:' + win.location.pathname;
    var touchStart = null;

    function pageSections() {
      return Array.prototype.filter.call(slides.children, function (child) {
        return child.tagName === 'SECTION';
      });
    }

    function storedIds() {
      try {
        var saved = JSON.parse(win.localStorage.getItem(idsStore));
        if (Array.isArray(saved) && saved.length) return normalisePageIds(saved);
      } catch (error) { /* unreadable or unavailable */ }
      var count = 1;
      try { count = Number(win.localStorage.getItem(countStore)) || 1; } catch (error) { /* unavailable */ }
      count = Math.max(1, Math.min(MAX_PAGES, Math.floor(count)));
      return Array.from({ length: count }, function (_, index) { return pageId(index + 1); });
    }

    function makePage(id) {
      var section = doc.createElement('section');
      section.id = id;
      section.className = 'slide level2 annotation-slide-heading';
      section.appendChild(doc.createElement('h2'));
      slides.appendChild(section);
      return section;
    }

    // Keep the requested id before reveal has a chance to replace an unknown
    // dynamic-slide hash with the first page during its own initialisation.
    var requestedPage = pageNumber(win.__scribbleInitialHash || win.location.hash);
    var sourceIds = pageSections().map(function (section) { return section.id; });
    var pageIds = normalisePageIds(sourceIds.concat(storedIds()));
    if (requestedPage && pageIds.indexOf(pageId(requestedPage)) === -1) {
      pageIds.push(pageId(requestedPage));
    }
    pageIds.forEach(function (id) {
      var section = doc.getElementById(id) || makePage(id);
      slides.appendChild(section); // restore the persisted order as well as membership
    });

    function persist() {
      try {
        win.localStorage.setItem(idsStore, JSON.stringify(pageIds));
        win.localStorage.setItem(countStore, String(pageIds.length)); // v1 migration fallback
      } catch (error) { /* full or unavailable */ }
    }

    function pageIndex(section) { return pageSections().indexOf(section); }

    function addMenuItem(list, section, index) {
      var item = doc.createElement('li');
      var current = win.Reveal && win.Reveal.getCurrentSlide && win.Reveal.getCurrentSlide();
      var currentIndex = current ? pageIndex(current) : 0;
      item.className = 'slide-menu-item ' +
        (index < currentIndex ? 'past' : index === currentIndex ? 'active' : 'future');
      item.dataset.item = String(index);
      item.dataset.slideH = String(index);
      item.dataset.slideV = '0';
      var title = doc.createElement('span');
      title.className = 'slide-menu-item-title';
      title.textContent = 'Slide ' + (index + 1);
      item.appendChild(title);
      item.addEventListener('click', function () {
        win.Reveal.slide(index, 0);
        var menu = win.Reveal.getPlugin && win.Reveal.getPlugin('menu');
        if (menu && menu.closeMenu) menu.closeMenu();
      });
      list.appendChild(item);
    }

    function refreshMenu() {
      var list = doc.querySelector('.slide-menu-panel[data-panel="Slides"] > .slide-menu-items');
      if (!list) return;
      list.replaceChildren();
      pageSections().forEach(function (section, index) { addMenuItem(list, section, index); });
    }

    function nextNumber() {
      return pageIds.reduce(function (highest, id) {
        return Math.max(highest, pageNumber(id));
      }, 0) + 1;
    }

    function syncPages() {
      persist();
      if (win.Reveal && win.Reveal.sync) win.Reveal.sync();
      refreshMenu();
      win.requestAnimationFrame(refreshForwardControl);
    }

    function appendOne() {
      var number = nextNumber();
      if (number > MAX_PAGES) return null;
      var id = pageId(number);
      pageIds.push(id);
      return makePage(id);
    }

    function append() {
      var section = appendOne();
      if (section) syncPages();
      return section;
    }

    function ensure(wanted, sync) {
      wanted = Math.max(1, Math.min(MAX_PAGES, Math.floor(Number(wanted) || 1)));
      var added = null;
      while (pageIds.length < wanted) added = appendOne();
      if (sync && added) syncPages();
      else persist();
      return added || pageSections()[Math.min(wanted, pageIds.length) - 1];
    }

    function ensureIds(values, sync) {
      var added = null;
      normalisePageIds(values).forEach(function (id) {
        if (pageIds.indexOf(id) !== -1) return;
        pageIds.push(id);
        added = doc.getElementById(id) || makePage(id);
      });
      if (sync && added) syncPages();
      else persist();
      return added;
    }

    function removeCurrent() {
      var sections = pageSections();
      if (sections.length <= 1 || !win.Reveal || !win.Reveal.getCurrentSlide) return null;
      var current = win.Reveal.getCurrentSlide();
      var index = sections.indexOf(current);
      if (index < 0) return null;
      var target = sections[index > 0 ? index - 1 : 1];
      var targetIndices = win.Reveal.getIndices(target);
      var removedId = current.id;
      win.Reveal.slide(targetIndices.h, targetIndices.v);
      current.remove();
      pageIds = pageIds.filter(function (id) { return id !== removedId; });
      syncPages();
      return removedId;
    }

    function atEnd() {
      if (!win.Reveal || !win.Reveal.isReady || !win.Reveal.isReady()) return false;
      if (win.Reveal.isOverview && win.Reveal.isOverview()) return false;
      if (!win.Reveal.isLastSlide || !win.Reveal.isLastSlide()) return false;
      var fragments = win.Reveal.availableFragments && win.Reveal.availableFragments();
      return !(fragments && fragments.next);
    }

    // Reveal normally hides and disables its forward arrow on the final slide.
    // Here that arrow means "make the next page", so keep it available there.
    function refreshForwardControl() {
      var button = doc.querySelector('.controls .navigate-right');
      if (!button || !atEnd()) return;
      button.disabled = false;
      button.classList.add('enabled');
    }

    function prepareForwardPage() { if (atEnd()) append(); }

    function forwardKey(event) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      var target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'n', 'N'].indexOf(event.key) !== -1) {
        prepareForwardPage();
      }
    }

    function forwardControl(event) {
      var target = event.target && event.target.closest &&
        event.target.closest('.navigate-right, .navigate-down');
      if (target) prepareForwardPage();
    }

    function touchDown(event) {
      if (event.touches.length !== 1 || !atEnd()) { touchStart = null; return; }
      touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }

    function touchUp(event) {
      if (!touchStart || event.changedTouches.length !== 1) { touchStart = null; return; }
      var dx = event.changedTouches[0].clientX - touchStart.x;
      var dy = event.changedTouches[0].clientY - touchStart.y;
      touchStart = null;
      if (dx < -40 && Math.abs(dx) > Math.abs(dy)) prepareForwardPage();
    }

    runtime = {
      append: append,
      count: function () { return pageIds.length; },
      ids: function () { return pageIds.slice(); },
      ensure: function (count) { return ensure(count, true); },
      ensureIds: function (ids) { return ensureIds(ids, true); },
      ensureForKeys: function (keys) { return ensureIds(keys, true); },
      canRemove: function () { return pageIds.length > 1; },
      removeCurrent: removeCurrent
    };
    persist();

    function attach() {
      if (!win.Reveal || !win.Reveal.isReady || !win.Reveal.isReady()) return false;
      win.Reveal.sync();
      if (requestedPage) {
        var target = doc.getElementById(pageId(requestedPage));
        if (target && win.Reveal.getCurrentSlide() !== target) {
          var indices = win.Reveal.getIndices(target);
          win.Reveal.slide(indices.h, indices.v);
        }
      }
      refreshForwardControl();
      refreshMenu();
      // Reveal dispatches slidechanged before its controls plugin performs its
      // final update, so restore the create-page arrow on the following frame.
      win.Reveal.on('slidechanged', function () {
        win.requestAnimationFrame(refreshForwardControl);
      });
      var revealElement = doc.querySelector('.reveal');
      if (revealElement) revealElement.addEventListener('menu-ready', refreshMenu);
      win.setTimeout(refreshMenu, 100);
      win.addEventListener('click', forwardControl, true);
      win.addEventListener('keydown', forwardKey, true);
      win.addEventListener('touchstart', touchDown, { capture: true, passive: true });
      win.addEventListener('touchend', touchUp, { capture: true, passive: true });
      win.addEventListener('touchcancel', function () { touchStart = null; }, true);
      return true;
    }

    if (!attach()) {
      var interval = win.setInterval(function () { if (attach()) win.clearInterval(interval); }, 50);
      win.setTimeout(function () { win.clearInterval(interval); }, 10000);
    }
    return runtime;
  }

  return {
    install: install,
    pageId: pageId,
    pageNumber: pageNumber,
    normalisePageIds: normalisePageIds,
    requiredPageCount: requiredPageCount,
    append: function () { return runtime && runtime.append(); },
    count: function () { return runtime ? runtime.count() : 0; },
    ids: function () { return runtime ? runtime.ids() : []; },
    ensure: function (count) { return runtime && runtime.ensure(count); },
    ensureIds: function (ids) { return runtime && runtime.ensureIds(ids); },
    ensureForKeys: function (keys) { return runtime && runtime.ensureForKeys(keys); },
    canRemove: function () { return !!runtime && runtime.canRemove(); },
    removeCurrent: function () { return runtime && runtime.removeCurrent(); }
  };
});
