# unsw-theme

The UNSW look for reveal.js lecture slides: the yellow rail, the title-slide
pentagon, the palette and the type. It is a theme layer over the
`Pat-Laub/slide-stage` format extension, which draws the page furniture but
carries no colour of its own — the two hooks it exposes are all this supplies:

```scss
$stage-artwork-image: url("...");   // the title-slide pentagon
$stage-rail-background: $unsw-yellow;
```

## Using it

This is not a Quarto extension — it is a stylesheet and a logo, so it is
vendored as a plain directory rather than through `_extensions/`:

```sh
git subtree add --prefix=unsw-theme <repo> unsw-theme-v1.0.0 --squash
```

```yaml
format:
  slide-stage-revealjs:
    logo: unsw-theme/unsw-logo.png
    theme:
      - unsw-theme/unsw-theme.scss
      - _extensions/Pat-Laub/annotate/annotate.scss
```

It is look only: course content classes (Beamer compatibility, solutions,
theorem environments) belong to the course that uses them.

Everything is a `!default` where a course might reasonably differ, so a course
can set its own fonts or accent above this layer without editing it.

## Releasing

```sh
git tag unsw-theme-v1.0.0 && git push --tags
```

Consumers refresh with `git subtree pull --prefix=unsw-theme <repo> <tag> --squash`.
