# Changelog

All notable changes to Pocket Kneeboard. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.2 (2026-11-15)

### Fixed

- Part II now follows every airport you select, including the one Part I already shows (your
  destination in flight, or where you're parked). Before, such a selection was ignored and Part II
  kept showing an older airport. Helipads and seaplane bases are still skipped.
- Part I's remarks box fits on its one ruled line. A long "+$X since" remark used to wrap and hide
  the "This was me" box. When there's a rise to claim, the box now shows the check box with the
  reason in small print. Otherwise it shows the first remark, cut short with an ellipsis.

## 0.1.1 (2026-11-15)

### Fixed

- Schedule A's meter bars draw cleanly. The hand-drawn effect broke up the thin ticks and left
  holes in the fill, and the fill now stops at 100%.
- Numbers in the ledger no longer get cut off ("250.0") in panels narrower than 360px.
- Part II no longer goes blank when you select your destination or the airport you're parked at.
  Helipads and seaplane bases can't be selected, and the extension doesn't fetch standings for
  them.

### Development

- `npm run preview` takes seconds instead of about three minutes.

## 0.1.0 (2026-11-15)

First release.

- A side panel styled as a paper FAA-style form that shows influence standings for your current
  airport and the airport you have open on the map.
- A weekly influence ledger that records the pay of each landing against the airport it counts
  for, including round trips to ships, rigs and helipads.
- Ctrl+Shift+K (Command+Shift+K on a Mac) opens the panel in its own window, for the installed
  app, whose windows have no side panel.
- A "Print size" setting that zooms the form from 50% to 150%.
