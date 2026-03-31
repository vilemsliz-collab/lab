# Lab — Claude Code

Personal experiment space deployed at **vilemsliz-collab.github.io/lab**.

## Structure

- `index.html` — landing page, lists all experiments
- `<name>.html` — self-contained experiment (preferred)
- `<name>/index.html` — when an experiment needs assets

No build step. No package.json. Pure HTML/CSS/JS files committed directly.

## Style conventions

- Background: `#0d0d0d`
- Foreground: `#e8e8e0`
- Muted text: `#555`
- Accent: `#c8ff00`
- Font: IBM Plex Mono (`@import` from Google Fonts)
- Font sizes: 11px labels, 14px body, 18px headings

## Adding an experiment

1. Create `<name>.html` in root (or `<name>/index.html` for multi-file)
2. Add a back link: `<a href="./index.html">← lab</a>`
3. Add entry to `index.html` list (pad the number, format date as `YYYY-MM`)

## Deploy

```
git add -A && git commit -m "<msg>" && git push
```

GitHub Pages serves from `main` branch root. Changes go live in ~60 seconds.

## CDN libs used so far

- Three.js: `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js`
- IBM Plex Mono: Google Fonts
- Plus Jakarta Sans: Google Fonts (orbs-v5)
