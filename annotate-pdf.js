// A tiny vector PDF encoder for Scribble's blank pages, ruled guides and ink.
// It deliberately has no DOM or third-party dependency, which keeps direct
// downloads available in iPad Safari and makes the output geometry testable.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AnnotationPdf = api;
})(typeof window !== 'undefined' ? window : this, function () {
  var encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function number(value) {
    var rounded = Math.round(value * 10000) / 10000;
    if (Object.is(rounded, -0)) rounded = 0;
    return String(rounded);
  }

  function colour(value) {
    var match = /^#([0-9a-f]{6})$/i.exec(value || '');
    if (!match) return '0 0 0';
    return [0, 2, 4].map(function (at) {
      return number(parseInt(match[1].slice(at, at + 2), 16) / 255);
    }).join(' ');
  }

  function isCommand(token) { return /^[a-z]$/i.test(token); }

  // perfect-freehand paths use SVG quadratic curves. PDF has only cubic
  // curves, so convert each Q segment exactly rather than flattening the ink.
  function quadraticPathToPdf(path) {
    var tokens = String(path || '').match(/[a-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/ig) || [];
    var out = [], at = 0, command = '', current = [0, 0], start = [0, 0];
    function take() { return parseFloat(tokens[at++]); }
    while (at < tokens.length) {
      if (isCommand(tokens[at])) command = tokens[at++].toUpperCase();
      if (!command) throw new Error('Invalid SVG path data');
      if (command === 'M' || command === 'L') {
        if (at + 1 >= tokens.length || isCommand(tokens[at])) throw new Error('Invalid SVG path data');
        current = [take(), take()];
        if (command === 'M') start = current.slice();
        out.push(number(current[0]) + ' ' + number(current[1]) + (command === 'M' ? ' m' : ' l'));
        if (command === 'M') command = 'L';
      } else if (command === 'Q') {
        if (at + 3 >= tokens.length || isCommand(tokens[at])) throw new Error('Invalid SVG path data');
        var control = [take(), take()], end = [take(), take()];
        var c1 = [
          current[0] + (control[0] - current[0]) * 2 / 3,
          current[1] + (control[1] - current[1]) * 2 / 3
        ];
        var c2 = [
          end[0] + (control[0] - end[0]) * 2 / 3,
          end[1] + (control[1] - end[1]) * 2 / 3
        ];
        out.push([c1[0], c1[1], c2[0], c2[1], end[0], end[1]].map(number).join(' ') + ' c');
        current = end;
      } else if (command === 'C') {
        if (at + 5 >= tokens.length || isCommand(tokens[at])) throw new Error('Invalid SVG path data');
        var values = [take(), take(), take(), take(), take(), take()];
        current = values.slice(4);
        out.push(values.map(number).join(' ') + ' c');
      } else if (command === 'Z') {
        out.push('h');
        current = start.slice();
        command = '';
      } else {
        throw new Error('Unsupported SVG path command: ' + command);
      }
    }
    return out.join('\n');
  }

  function transformedPaths(strokes, scale, pageHeight) {
    var commands = ['q', number(scale) + ' 0 0 ' + number(-scale) + ' 0 ' + number(pageHeight) + ' cm'];
    (strokes || []).forEach(function (stroke) {
      if (!stroke.path) return;
      commands.push(colour(stroke.colour) + ' rg');
      commands.push(quadraticPathToPdf(stroke.path));
      commands.push('f');
    });
    commands.push('Q');
    return commands.join('\n');
  }

  var WIN_ANSI = {
    0x20ac: 128, 0x201a: 130, 0x0192: 131, 0x201e: 132, 0x2026: 133,
    0x2020: 134, 0x2021: 135, 0x02c6: 136, 0x2030: 137, 0x0160: 138,
    0x2039: 139, 0x0152: 140, 0x017d: 142, 0x2018: 145, 0x2019: 146,
    0x201c: 147, 0x201d: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151,
    0x02dc: 152, 0x2122: 153, 0x0161: 154, 0x203a: 155, 0x0153: 156,
    0x017e: 158, 0x0178: 159
  };

  // Core PDF Helvetica uses WinAnsi. Keep the PDF itself ASCII by writing
  // non-ASCII bytes as octal escapes, and substitute only characters that the
  // standard font genuinely cannot represent.
  function pdfString(value) {
    var out = '';
    Array.from(String(value || '')).forEach(function (character) {
      var code = character.codePointAt(0), byte = code;
      if (WIN_ANSI[code] !== undefined) byte = WIN_ANSI[code];
      else if (code > 255) byte = 63;
      if (byte === 40 || byte === 41 || byte === 92) out += '\\' + String.fromCharCode(byte);
      else if (byte < 32 || byte > 126) out += '\\' + byte.toString(8).padStart(3, '0');
      else out += String.fromCharCode(byte);
    });
    return '(' + out + ')';
  }

  function transformedText(items, scale, pageHeight) {
    var commands = [];
    (items || []).forEach(function (item) {
      var size = Number(item.fontSize) || 32;
      var lineHeight = Number(item.lineHeight) || size * 1.25;
      var padding = Number(item.padding) || size * 0.16;
      var x = (Number(item.x) + padding) * scale;
      var y = pageHeight - (Number(item.y) + padding + size) * scale;
      commands.push('BT');
      commands.push('/F1 ' + number(size * scale) + ' Tf');
      commands.push(colour(item.colour) + ' rg');
      commands.push(number(x) + ' ' + number(y) + ' Td');
      (item.lines || ['']).forEach(function (line, index) {
        if (index) commands.push('0 ' + number(-lineHeight * scale) + ' Td');
        commands.push(pdfString(line) + ' Tj');
      });
      commands.push('ET');
    });
    return commands.join('\n');
  }

  function stream(dictionary, contents) {
    return '<< ' + dictionary + ' /Length ' + contents.length + ' >>\nstream\n' +
      contents + '\nendstream';
  }

  function bytes(value) {
    if (encoder) return encoder.encode(value);
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i);
    return out;
  }

  function create(options) {
    options = options || {};
    var width = Number(options.width), height = Number(options.height);
    if (!(width > 0 && height > 0)) throw new Error('PDF canvas dimensions must be positive');
    var pages = options.pages && options.pages.length ? options.pages : [{}];
    var pageHeight = Number(options.pageHeight) > 0 ? Number(options.pageHeight) : 540;
    var pageWidth = pageHeight * width / height;
    var scale = pageHeight / height;
    var rules = options.rules || [];
    var margin = Number(options.ruleMargin) || 0;
    var objects = [null];
    function reserve() { objects.push(null); return objects.length - 1; }

    var catalogRef = reserve();
    var pagesRef = reserve();
    var highlighterStateRef = reserve();
    var fontRef = reserve();
    var records = pages.map(function (page) {
      var strokes = page.strokes || [];
      var highlighters = strokes.filter(function (stroke) { return stroke.tool === 'highlighter' && stroke.path; });
      return {
        page: reserve(),
        content: reserve(),
        form: highlighters.length ? reserve() : null,
        pens: strokes.filter(function (stroke) { return stroke.tool === 'pen' && stroke.path; }),
        highlighters: highlighters,
        text: page.text || []
      };
    });

    objects[catalogRef] = '<< /Type /Catalog /Pages ' + pagesRef + ' 0 R >>';
    objects[pagesRef] = '<< /Type /Pages /Count ' + records.length + ' /Kids [' +
      records.map(function (record) { return record.page + ' 0 R'; }).join(' ') + '] >>';
    objects[highlighterStateRef] =
      '<< /Type /ExtGState /ca 0.4 /CA 0.4 /BM /Multiply >>';
    objects[fontRef] =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

    records.forEach(function (record, index) {
      var resourceParts = [];
      if (record.form) {
        resourceParts.push('/ExtGState << /HL ' + highlighterStateRef + ' 0 R >>');
        resourceParts.push('/XObject << /H' + index + ' ' + record.form + ' 0 R >>');
      }
      if (record.text.length) resourceParts.push('/Font << /F1 ' + fontRef + ' 0 R >>');
      objects[record.page] = '<< /Type /Page /Parent ' + pagesRef + ' 0 R' +
        ' /MediaBox [0 0 ' + number(pageWidth) + ' ' + number(pageHeight) + ']' +
        ' /Resources << ' + resourceParts.join(' ') + ' >>' +
        ' /Contents ' + record.content + ' 0 R >>';

      var content = ['q', '1 1 1 rg', '0 0 ' + number(pageWidth) + ' ' + number(pageHeight) + ' re f', 'Q'];
      if (rules.length) {
        content.push('q');
        content.push(number(scale) + ' 0 0 ' + number(-scale) + ' 0 ' + number(pageHeight) + ' cm');
        content.push('0.83 0.882 0.956 RG');
        content.push('1.5 w');
        rules.forEach(function (y) {
          content.push(number(margin) + ' ' + number(y) + ' m ' +
            number(width - margin) + ' ' + number(y) + ' l S');
        });
        content.push('Q');
      }
      if (record.form) content.push('q /HL gs /H' + index + ' Do Q');
      if (record.pens.length) content.push(transformedPaths(record.pens, scale, pageHeight));
      if (record.text.length) content.push(transformedText(record.text, scale, pageHeight));
      objects[record.content] = stream('', content.join('\n'));

      if (record.form) {
        var highlighterContent = transformedPaths(record.highlighters, scale, pageHeight);
        objects[record.form] = stream(
          '/Type /XObject /Subtype /Form /FormType 1' +
          ' /BBox [0 0 ' + number(pageWidth) + ' ' + number(pageHeight) + ']' +
          ' /Group << /S /Transparency /CS /DeviceRGB /I true /K false >>' +
          ' /Resources << >>',
          highlighterContent
        );
      }
    });

    var header = '%PDF-1.7\n% Scribble vector annotations\n';
    var body = header, offsets = [0];
    for (var i = 1; i < objects.length; i++) {
      offsets[i] = body.length;
      body += i + ' 0 obj\n' + objects[i] + '\nendobj\n';
    }
    var xref = body.length;
    body += 'xref\n0 ' + objects.length + '\n';
    body += '0000000000 65535 f \n';
    for (var j = 1; j < objects.length; j++) {
      body += String(offsets[j]).padStart(10, '0') + ' 00000 n \n';
    }
    body += 'trailer\n<< /Size ' + objects.length + ' /Root ' + catalogRef + ' 0 R >>\n';
    body += 'startxref\n' + xref + '\n%%EOF\n';
    return bytes(body);
  }


  /* ------------------------ overlaying a published PDF -------------------- */

  // The other way to get ink into a PDF: rather than drawing the pages here,
  // read a PDF published beside the deck and append the ink to it as an
  // incremental update -- new objects, a fresh xref, and a trailer pointing at
  // the old one. Only classic xref tables are supported, which is what both
  // headless Chrome and PyMuPDF write.

  function text(bytes, from, to) {
    from = Math.max(0, from);
    to = Math.min(bytes.length, to === undefined ? bytes.length : to);
    var out = '', step = 0x8000;
    for (var i = from; i < to; i += step) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, to)));
    }
    return out;
  }

  /* ------------------------- dictionaries and values ---------------------- */

  var SPACE = /[\s\0]/;

  function skip(source, i) {
    while (i < source.length) {
      if (SPACE.test(source.charAt(i))) i++;
      else if (source.charAt(i) === '%') { while (i < source.length && !/[\r\n]/.test(source.charAt(i))) i++; }
      else break;
    }
    return i;
  }

  function endOfName(source, i) {
    i++;  // the '/'
    while (i < source.length && !SPACE.test(source.charAt(i)) &&
      '/[]<>(){}%'.indexOf(source.charAt(i)) < 0) i++;
    return i;
  }

  // The end of the one object starting at `i`. Only as much of the grammar as
  // page dictionaries use, but nesting, strings and references are exact —
  // a `>>` inside a string or a nested dictionary must not end the outer one.
  function endOfValue(source, i) {
    var c = source.charAt(i);
    if (c === '/') return endOfName(source, i);
    if (c === '(') {
      var depth = 0;
      for (; i < source.length; i++) {
        var ch = source.charAt(i);
        if (ch === '\\') i++;
        else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return i + 1;
      }
      return i;
    }
    if (c === '<' && source.charAt(i + 1) !== '<') {
      var close = source.indexOf('>', i);
      return close < 0 ? source.length : close + 1;
    }
    if (c === '<' || c === '[') {
      var open = c === '[' ? '[' : '<<', shut = c === '[' ? ']' : '>>';
      var level = 0, j = i;
      while (j < source.length) {
        if (source.substr(j, open.length) === open) { level++; j += open.length; }
        else if (source.substr(j, shut.length) === shut) {
          level--; j += shut.length;
          if (!level) return j;
        } else if (source.charAt(j) === '(') j = endOfValue(source, j);
        else j++;
      }
      return j;
    }
    // A bare token: a number, a keyword, or the first half of an `n g R`.
    var k = i;
    while (k < source.length && !SPACE.test(source.charAt(k)) &&
      '/[]<>(){}%'.indexOf(source.charAt(k)) < 0) k++;
    var reference = /^(\s*\d+\s+R)/.exec(source.slice(k));
    if (reference && /^\d+$/.test(source.slice(i, k))) return k + reference[1].length;
    return k;
  }

  // The top-level entries of the dictionary starting at `<<`, in file order.
  function entries(dict) {
    var out = [], i = 2;
    while (i < dict.length) {
      i = skip(dict, i);
      if (dict.substr(i, 2) === '>>' || dict.charAt(i) !== '/') break;
      var key = i;
      i = endOfName(dict, i);
      var name = dict.slice(key, i);
      i = skip(dict, i);
      var start = i;
      i = endOfValue(dict, i);
      out.push({ key: name, start: start, end: i, value: dict.slice(start, i) });
    }
    return out;
  }

  function lookup(dict, key) {
    var found = null;
    entries(dict).forEach(function (entry) { if (entry.key === key) found = entry; });
    return found;
  }

  function referenceTo(value) {
    var match = /^(\d+)\s+\d+\s+R$/.exec(String(value).trim());
    return match ? Number(match[1]) : null;
  }

  function numbersIn(value) {
    return (String(value).match(/[-+]?(?:\d*\.\d+|\d+\.?)/g) || []).map(Number);
  }

  /* ------------------------------ reading a PDF --------------------------- */

  function read(bytes) {
    var tail = text(bytes, bytes.length - 2048);
    var at = tail.lastIndexOf('startxref');
    if (at < 0) throw new Error('No startxref: this does not look like a PDF.');
    var start = /startxref\s+(\d+)/.exec(tail.slice(at));
    if (!start) throw new Error('Unreadable startxref.');

    // Offsets from the newest table win, so a table is only consulted for
    // objects no later table has already defined.
    var offsets = {}, trailer = null, seen = {}, next = Number(start[1]);
    while (next !== null && !seen[next]) {
      seen[next] = true;
      var section = readXrefSection(bytes, next, offsets);
      if (!trailer) trailer = section.trailer;
      var previous = lookup(section.trailer, '/Prev');
      next = previous ? Number(previous.value) : null;
    }
    return { bytes: bytes, offsets: offsets, trailer: trailer, startxref: Number(start[1]) };
  }

  function readXrefSection(bytes, offset, offsets) {
    var source = text(bytes, offset, offset + 4096);
    if (!/^\s*xref\b/.test(source)) {
      throw new Error(
        'This PDF uses a cross-reference stream, which this exporter cannot read.'
      );
    }
    // The table runs 20 bytes per entry and can be long; take the whole rest of
    // the file rather than guessing a window, then stop at its own trailer.
    source = text(bytes, offset);
    var i = source.indexOf('xref') + 4;
    while (true) {
      i = skip(source, i);
      if (source.substr(i, 7) === 'trailer') break;
      var header = /^(\d+)\s+(\d+)/.exec(source.slice(i, i + 48));
      if (!header) throw new Error('Unreadable cross-reference table.');
      var first = Number(header[1]), count = Number(header[2]);
      i = skip(source, i + header[0].length);
      for (var n = 0; n < count; n++) {
        var entry = /^(\d{10})\s+(\d{5})\s+([nf])/.exec(source.substr(i, 20));
        if (!entry) throw new Error('Unreadable cross-reference entry.');
        var object = first + n;
        // First definition seen wins: sections are visited newest first.
        if (entry[3] === 'n' && offsets[object] === undefined) offsets[object] = Number(entry[1]);
        i += 20;
        // Some writers use 19-byte rows; resynchronise rather than drift.
        if (!/^\s*(?:\d{10}|\d+\s+\d+|trailer)/.test(source.substr(i, 20))) i = skip(source, i);
      }
    }
    i = skip(source, i + 7);
    return { trailer: source.slice(i, endOfValue(source, i)) };
  }

  // The body of object `number`, without its `n g obj` / `endobj` wrapper.
  // Widened until the terminator is in view, since nothing says how long it is.
  function object(doc, number) {
    var offset = doc.offsets[number];
    if (offset === undefined) throw new Error('Missing object ' + number + '.');
    for (var window = 4096; ; window *= 4) {
      var source = text(doc.bytes, offset, offset + window);
      var head = /^\s*(\d+)\s+(\d+)\s+obj/.exec(source);
      if (!head) throw new Error('Object ' + number + ' is not where the table says.');
      var end = source.indexOf('endobj');
      if (end >= 0) return source.slice(head[0].length, end).trim();
      if (offset + window >= doc.bytes.length) throw new Error('Object ' + number + ' never ends.');
      if (window > 1 << 22) throw new Error('Object ' + number + ' is implausibly long.');
    }
  }

  function resolve(doc, value) {
    var reference = referenceTo(value);
    return reference === null ? value : object(doc, reference);
  }

  // Page object numbers, in the order the document presents them. The tree can
  // nest, and a /Kids array is authoritative about order, so walk it rather
  // than trusting object numbers to run in page order.
  function pageNumbers(doc) {
    var root = lookup(doc.trailer, '/Root');
    if (!root) throw new Error('No document catalogue.');
    var pages = lookup(object(doc, referenceTo(root.value)), '/Pages');
    if (!pages) throw new Error('No page tree.');
    var out = [], guard = 0;
    (function walk(number) {
      if (++guard > 10000) throw new Error('Page tree does not terminate.');
      var dict = object(doc, number);
      var kids = lookup(dict, '/Kids');
      if (!kids) { out.push(number); return; }
      var list = String(resolve(doc, kids.value));
      var reference, pattern = /(\d+)\s+\d+\s+R/g;
      while ((reference = pattern.exec(list))) walk(Number(reference[1]));
    })(referenceTo(pages.value));
    return out;
  }

  // MediaBox is inheritable, so a page that omits it takes its parent's.
  function mediaBox(doc, number) {
    for (var at = number, hops = 0; hops < 32; hops++) {
      var dict = object(doc, at);
      var box = lookup(dict, '/MediaBox');
      if (box) {
        var values = numbersIn(resolve(doc, box.value));
        if (values.length === 4) return values;
      }
      var parent = lookup(dict, '/Parent');
      if (!parent) break;
      at = referenceTo(parent.value);
      if (at === null) break;
    }
    throw new Error('Page ' + number + ' has no MediaBox.');
  }

  /* ----------------------------- placing the ink -------------------------- */

  // The printed page is the slide: both have the same fixed 16:9 bounds. Map
  // the authored 1248 × 702 coordinates directly to the PDF MediaBox.
  function placement(box, options) {
    var pageWidth = box[2] - box[0], pageHeight = box[3] - box[1];
    return {
      sx: pageWidth / options.width,
      sy: pageHeight / options.height,
      x: box[0],
      // Slide coordinates run downwards and PDF coordinates run upwards.
      y: box[1] + pageHeight
    };
  }

  function inkStream(page, spot, options) {
    var out = ['q'];
    out.push([number(spot.sx), 0, 0, number(-spot.sy), number(spot.x), number(spot.y)].join(' ') + ' cm');
    // Clip to the same fixed slide box used by the live annotation SVG.
    out.push('0 0 ' + number(options.width) + ' ' + number(options.height) + ' re W n');
    if (page.highlighter.length) {
      // One saved state for the whole group: /InkHL carries the 40% multiply
      // that the live highlighter layer gets from CSS, and applying it per
      // stroke would let overlapping strokes compound into dark blotches.
      out.push('q /InkHL gs');
      page.highlighter.forEach(function (stroke) {
        out.push(colour(stroke.colour) + ' rg');
        out.push(quadraticPathToPdf(stroke.path));
        out.push('f');
      });
      out.push('Q');
    }
    page.pen.forEach(function (stroke) {
      out.push(colour(stroke.colour) + ' rg');
      out.push(quadraticPathToPdf(stroke.path));
      out.push('f');
    });
    out.push('Q');
    return out.join('\n');
  }

  /* ------------------------------ writing it out -------------------------- */

  function pdfStream(contents) {
    return '<< /Length ' + contents.length + ' >>\nstream\n' + contents + '\nendstream';
  }

  function rebuild(dict, replacements) {
    var out = '', at = 2, handled = {};
    entries(dict).forEach(function (entry) {
      if (!(entry.key in replacements)) return;
      handled[entry.key] = true;
      out += dict.slice(at, entry.start) + replacements[entry.key](entry.value);
      at = entry.end;
    });
    out = '<<' + out + dict.slice(at, dict.lastIndexOf('>>'));
    Object.keys(replacements).forEach(function (key) {
      if (!handled[key]) out += '\n' + key + ' ' + replacements[key](null);
    });
    return out + '\n>>';
  }

  // Add /InkHL to the page's own ExtGState. Both writers in this pipeline put
  // /Resources inline in the page dictionary, so that is the case handled here;
  // an indirect one is left alone and the highlighter simply draws opaque
  // rather than the whole export failing.
  function withGraphicsState(dict, reference) {
    var resources = lookup(dict, '/Resources');
    if (!resources || resources.value.charAt(0) !== '<') return null;
    var states = lookup(resources.value, '/ExtGState');
    var updated;
    if (!states) {
      updated = rebuild(resources.value, {
        '/ExtGState': function () { return '<< /InkHL ' + reference + ' 0 R >>'; }
      });
    } else if (states.value.charAt(0) === '<') {
      updated = rebuild(resources.value, {
        '/ExtGState': function (value) {
          return value.slice(0, value.lastIndexOf('>>')) +
            ' /InkHL ' + reference + ' 0 R ' + value.slice(value.lastIndexOf('>>'));
        }
      });
    } else {
      return null;  // an indirect ExtGState; not worth a second rewrite
    }
    return rebuild(dict, { '/Resources': function () { return updated; } });
  }

  function xrefTable(records, size, trailer, previous, offset) {
    var numbers = Object.keys(records).map(Number).sort(function (a, b) { return a - b; });
    var out = 'xref\n', i = 0;
    while (i < numbers.length) {
      var run = 1;
      while (i + run < numbers.length && numbers[i + run] === numbers[i] + run) run++;
      out += numbers[i] + ' ' + run + '\n';
      for (var n = 0; n < run; n++) {
        out += String(records[numbers[i + n]]).padStart(10, '0') + ' 00000 n \n';
      }
      i += run;
    }
    var keep = ['/Root', '/Info', '/ID', '/Encrypt'].map(function (key) {
      var entry = lookup(trailer, key);
      return entry ? key + ' ' + entry.value : '';
    }).filter(Boolean).join('\n');
    return out + 'trailer\n<< /Size ' + size + '\n' + keep +
      '\n/Prev ' + previous + ' >>\nstartxref\n' + offset + '\n%%EOF\n';
  }

  function join(bytes, appended) {
    var out = new Uint8Array(bytes.length + appended.length);
    out.set(bytes, 0);
    for (var i = 0; i < appended.length; i++) out[bytes.length + i] = appended.charCodeAt(i) & 0xff;
    return out;
  }

  /* --------------------------------- entry -------------------------------- */

  // `pages` is one entry per PDF page, in order, each `{ pen: [], highlighter: [] }`
  // of `{ colour, path }` in slide coordinates. `options` carries the fixed
  // deck `width` and `height`; the PDF page is that same canvas. Returns the
  // new file; the original bytes are untouched inside it.
  function overlay(bytes, pages, options) {
    var doc = read(bytes);
    var numbers = pageNumbers(doc);
    if (pages.length !== numbers.length) {
      throw new Error(
        'The PDF has ' + numbers.length + ' pages but the deck has ' + pages.length +
        ' slides. It was built from a different version of this deck.'
      );
    }

    var size = Number(lookup(doc.trailer, '/Size').value);
    var body = '', records = {}, next = size;
    function add(contents) {
      var number = next++;
      records[number] = bytes.length + body.length + 1;  // +1 for the newline below
      body += '\n' + number + ' 0 obj\n' + contents + '\nendobj\n';
      return number;
    }
    function replace(number, contents) {
      records[number] = bytes.length + body.length + 1;
      body += '\n' + number + ' 0 obj\n' + contents + '\nendobj\n';
    }

    // Shared by every page: the original content streams are wrapped in these
    // so whatever graphics state a deck's own stream leaves behind cannot leak
    // into the ink, and the ink's own state cannot leak back.
    var opened = null, closed = null, highlight = null;

    pages.forEach(function (page, index) {
      if (!page.pen.length && !page.highlighter.length) return;
      var number = numbers[index];
      var dict = object(doc, number);

      if (page.highlighter.length) {
        if (highlight === null) {
          highlight = add('<< /Type /ExtGState /ca 0.4 /CA 0.4 /BM /Multiply >>');
        }
        var shaded = withGraphicsState(dict, highlight);
        // No room for the state: draw the highlighter as opaque ink rather
        // than dropping it, so nothing written is silently missing.
        if (shaded) dict = shaded;
        else page = { pen: page.highlighter.concat(page.pen), highlighter: [] };
      }

      if (opened === null) { opened = add(pdfStream('q')); closed = add(pdfStream('Q')); }
      var ink = add(pdfStream(inkStream(page, placement(mediaBox(doc, number), options), options)));

      replace(number, rebuild(dict, {
        '/Contents': function (value) {
          var existing = value.charAt(0) === '[' ? value.slice(1, -1) : value;
          return '[' + opened + ' 0 R ' + existing + ' ' + closed + ' 0 R ' + ink + ' 0 R]';
        }
      }));
    });

    if (!body) throw new Error('There are no annotations to add.');
    var offset = bytes.length + body.length + 1;
    return join(bytes, body + '\n' + xrefTable(records, next, doc.trailer, doc.startxref, offset));
  }

  return {
    create: create, overlay: overlay,
    quadraticPathToPdf: quadraticPathToPdf, pdfString: pdfString,
    // Exported for tests, which check the geometry without a PDF in hand.
    placement: placement
  };
});
