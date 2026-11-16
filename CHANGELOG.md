# Changelog

All notable changes to Pocket Kneeboard. Versions follow [Semantic Versioning](https://semver.org/).

## 0.2.0 (2026-11-16)

### Added

- Flights from other devices, such as your phone, can now count. A small script
  (`server/kneeboard_poll.py`) runs on a server once a minute and logs every landing by your
  company's pilots, with the influence each added. Enter its URL on the Instructions page.
  - A flight counts when the log can tell it was yours alone.
  - A flight that shared an airport with a teammate is listed with an estimate but not counted.
  - A flight whose pay isn't known is listed as "pay not known".
- A "Capped" stamp over the bubbles once you reach $250,000 at an airport this week.
- The Instructions page shows your company's id, for whoever runs the script.

### Changed

- The form tracks this week only. Last week's half is already in the company totals the game
  shows, so its bubbles, lines and Schedule A columns are gone. Schedule A lists only the
  airports you flew to this week, with the room left at each.
- Each part of the worksheet has four lines of remarks, one remark per line.
- Schedule A keeps one tab however many airports you fly to. Turn the corner of a sheet to see
  the next one.

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
