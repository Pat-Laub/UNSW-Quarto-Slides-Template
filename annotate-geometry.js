// Pure geometry shared by the annotation UI and its tests. Keeping these
// operations free of DOM and reveal.js state also makes them portable to a
// presenter/viewer setup.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AnnotationGeometry = api;
})(typeof window !== 'undefined' ? window : this, function () {
  function rulePositions(height, spacing, margin) {
    var out = [];
    for (var y = margin; y <= height - margin; y += spacing) out.push(y);
    return out;
  }

  function pointInPolygon(point, polygon) {
    var inside = false, x = point[0], y = point[1];
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var a = polygon[i], b = polygon[j];
      var crosses = (a[1] > y) !== (b[1] > y) &&
        x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0];
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function polygonContainsPoints(polygon, points) {
    return polygon.length >= 3 && points.length > 0 && points.every(function (p) {
      return pointInPolygon(p, polygon);
    });
  }

  function pointsBounds(points) {
    if (!points.length) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    points.forEach(function (p) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    });
    return [x0, y0, x1, y1];
  }

  function insideBounds(point, box, padding) {
    padding = padding || 0;
    return !!box && point[0] >= box[0] - padding && point[0] <= box[2] + padding &&
      point[1] >= box[1] - padding && point[1] <= box[3] + padding;
  }

  function translatePoints(points, dx, dy) {
    return points.map(function (p) { return [p[0] + dx, p[1] + dy, p[2]]; });
  }

  // Convert a browser viewport point through the rendered slide rectangle.
  // Points outside the rectangle deliberately remain outside the canvas; the
  // annotation surface extends into Reveal's letterbox so strokes can begin at
  // an edge without being clipped.
  function pointFromRect(point, rect, width, height) {
    return [
      Math.round((point[0] - rect.left) / rect.width * width * 10) / 10,
      Math.round((point[1] - rect.top) / rect.height * height * 10) / 10
    ];
  }

  function scalePoints(points, anchor, scale) {
    return points.map(function (p) {
      return [
        anchor[0] + (p[0] - anchor[0]) * scale,
        anchor[1] + (p[1] - anchor[1]) * scale,
        p[2]
      ];
    });
  }

  function resizeHandle(point, box, radius) {
    if (!box) return null;
    var corners = [
      ['nw', box[0], box[1]], ['ne', box[2], box[1]],
      ['se', box[2], box[3]], ['sw', box[0], box[3]]
    ];
    var best = null, distance = Infinity;
    corners.forEach(function (corner) {
      var d = Math.hypot(point[0] - corner[1], point[1] - corner[2]);
      if (d <= radius && d < distance) {
        best = { name: corner[0], point: [corner[1], corner[2]] };
        distance = d;
      }
    });
    return best;
  }

  // Project the dragged corner onto its original diagonal from the fixed
  // opposite corner. This gives one uniform scale even if the pointer wanders
  // sideways, preserving handwriting proportions rather than skewing it.
  function uniformScale(anchor, originalCorner, draggedCorner, minimum) {
    var x = originalCorner[0] - anchor[0], y = originalCorner[1] - anchor[1];
    var length = x * x + y * y;
    if (!length) return 1;
    var scale = ((draggedCorner[0] - anchor[0]) * x +
      (draggedCorner[1] - anchor[1]) * y) / length;
    return Math.max(minimum || 0, scale);
  }

  return {
    rulePositions: rulePositions,
    pointInPolygon: pointInPolygon,
    polygonContainsPoints: polygonContainsPoints,
    pointsBounds: pointsBounds,
    insideBounds: insideBounds,
    translatePoints: translatePoints,
    pointFromRect: pointFromRect,
    scalePoints: scalePoints,
    resizeHandle: resizeHandle,
    uniformScale: uniformScale
  };
});
