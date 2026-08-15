# UNSW-Quarto-Slides-Template

This is a template for using Quarto to produce slides with the UNSW theme.

UNSW students or staff may find this useful for preparing teaching or research materials.

Take a look at the generated slides at [https://pat-laub.github.io/UNSW-Quarto-Slides-Template/template.html](https://pat-laub.github.io/UNSW-Quarto-Slides-Template/template.html).

## Getting started

With [Quarto](https://quarto.org) installed, run

```bash
quarto use template Pat-Laub/UNSW-Quarto-Slides-Template
```

in an empty directory.
This downloads just the files you need to start a new set of slides: `template.qmd`, `custom.scss`, `annotate.scss`, `reveal-fixes.html`, `annotate.js`, `perfect-freehand.min.js`, `unsw-logo.png` and `scripts/print_slides_pdfs.py`.

Then render the slides with `quarto render template.qmd`, or use the Render button in RStudio or VS Code (with the Quarto extension).

## PDF slides

```bash
python scripts/print_slides_pdfs.py
```

turns `template.html` into `template.pdf`. It loads the deck in headless Chrome with reveal.js's own `?print-pdf` view, so the text and figures stay vector rather than being screenshotted, and the presentation controls stay out of the PDF.

## Drawing on the slides

Press <kbd>d</kbd> during a presentation (or click the pen in the bottom-left corner) to open the drawing tools: a pen, a highlighter and an eraser, in five colours (the first draws yellow while the highlighter is out).
The eraser removes a whole stroke at a time rather than rubbing out pixels, <kbd>⌘Z</kbd>/<kbd>Ctrl+Z</kbd> undoes, <kbd>v</kbd> hides the ink to show the slide underneath, and <kbd>Esc</kbd> puts the tools away.
Draw with a mouse, a finger, or a stylus — an Apple Pencil on an iPad is what it is meant for, and once a pen has been used a finger swipes to the next slide instead of drawing.
Annotations are saved in the browser, so they survive a reload and are still there when you return to a slide; the last two buttons on the panel write the whole deck's ink out to a file and read one back, since the browser's copy does not follow you to another device.

You can also rub something out without putting the pen down: scribble back and forth across it and it goes when you lift the pen.
The ink that will go fades as you scribble, so you can see what you are about to take; one undo brings it back.
The eraser works the same way: what you pass over fades, and goes when you lift.
Only ink of the same colour drawn with the same tool is erased this way, and a scribble over empty slide is just a scribble.
Holding the right mouse button — or the barrel button on a stylus — erases in the same two steps without switching tools, and hands back the pen when you let go.

This is `annotate.js`, which uses [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT) to shape the strokes; it replaces the reveal.js chalkboard plugin.

The demo slides include a couple of Python code cells, so rendering them as-is requires the `jupyter`, `matplotlib` and `seaborn` Python packages.
If you don't need Python, just delete those cells from `template.qmd`.
