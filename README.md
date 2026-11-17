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
This downloads just the files you need to start a new set of slides: `template.qmd`, `custom.scss`, `Then render the slides with `quarto render template.qmd`, or use the Render button in RStudio or VS Code (with the Quarto extension).

## PDF slides

Open `template.html` in Chrome and press <kbd>⌘P</kbd>/<kbd>Ctrl+P</kbd>, then choose "Save as PDF".
The deck prints its own print layout, one full slide per page, so the text and figures stay vector and the presentation controls stay out of the PDF.

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

This is `
The demo slides include a couple of Python code cells, so rendering them as-is requires the `jupyter`, `matplotlib` and `seaborn` Python packages.
If you don't need Python, just delete those cells from `template.qmd`.

## What this template is made of

The fixed 16:9 slide stage, the reveal.js fixes and the freehand drawing tools
are Quarto extensions, vendored here as git subtrees under `_extensions/`:

- `Pat-Laub/slide-stage` — the authored 3744 x 2106 page and one uniform fit
  transform, so a deck lays out identically on a laptop, a projector and an iPad
- `Pat-Laub/scribble` — pen, highlighter, text, lasso, eraser and persistence

`quarto use template` skips `_extensions` when it copies files and installs the
extensions properly instead, so a new deck gets them without this repo's git
plumbing. `custom.scss` is the UNSW look, supplied through the two hooks the
stage exposes.

## Testing

```sh
npm install
npx playwright install chromium firefox webkit
npm run render
npm test        # chromium, firefox, webkit
```

The suite checks the deck a new user is handed: it loads with no failed
requests, it is drawn on the shared stage in authored units, the UNSW rail and
title artwork come through the stage hooks, the drawing tools draw, and the deck
does not grow pages (which belongs to the blank pad, not a lecture deck).
