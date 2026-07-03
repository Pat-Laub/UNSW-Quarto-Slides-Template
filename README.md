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
This downloads just the files you need to start a new set of slides: `template.qmd`, `custom.scss`, `reveal-fixes.html` and `unsw-logo.png`.

Then render the slides with `quarto render template.qmd`, or use the Render button in RStudio or VS Code (with the Quarto extension).

The demo slides include a couple of Python code cells, so rendering them as-is requires the `jupyter`, `matplotlib` and `seaborn` Python packages.
If you don't need Python, just delete those cells from `template.qmd`.
