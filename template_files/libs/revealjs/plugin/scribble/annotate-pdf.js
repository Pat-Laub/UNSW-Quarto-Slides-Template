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

  return { create: create, quadraticPathToPdf: quadraticPathToPdf, pdfString: pdfString };
});
