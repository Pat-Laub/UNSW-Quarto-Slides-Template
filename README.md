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
This downloads just the files you need to start a new set of slides: `template.qmd`, `custom.scss`, `reveal-fixes.html`, `annotate.js`, `perfect-freehand.min.js` and `unsw-logo.png`.

Then render the slides with `quarto render template.qmd`, or use the Render button in RStudio or VS Code (with the Quarto extension).

## Drawing on the slides

Press <kbd>d</kbd> during a presentation (or click the pen in the bottom-left corner) to open the drawing tools: a pen, a highlighter and an eraser, in five colours.
The eraser removes a whole stroke at a time rather than rubbing out pixels, <kbd>⌘Z</kbd>/<kbd>Ctrl+Z</kbd> undoes, and <kbd>Esc</kbd> puts the tools away.
Annotations are saved in the browser, so they survive a reload and are still there when you return to a slide.

You can also rub something out without putting the pen down: scribble back and forth across it and it goes when you lift the pen.
The ink that will go fades as you scribble, so you can see what you are about to take; one undo brings it back.
Only ink of the same colour drawn with the same tool is erased this way, and a scribble over empty slide is just a scribble.

This is `annotate.js`, which uses [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT) to shape the strokes; it replaces the reveal.js chalkboard plugin.

The demo slides include a couple of Python code cells, so rendering them as-is requires the `jupyter`, `matplotlib` and `seaborn` Python packages.
If you don't need Python, just delete those cells from `template.qmd`.
