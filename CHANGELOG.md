# Changelog

All notable changes to Pocket Kneeboard. Versions follow [Semantic Versioning](https://semver.org/).

## 0.3.0 (2026-11-16)

### Added

- **Log**: each of your flights this week, with the plane, its net pay (the landing report's total)
  and the influence it added. Flights on another device come from the landing log, without net pay.
- **Fleet**: each of your planes and your company's, with its net pay and influence per hour over
  the last 7 days, and its net pay per hour over its whole life, as the game's hangar shows it.
- **Settings**, behind the gear tab: Print size and the landing log's URL moved here, and
  **Backup and restore** saves all your records as a file or to the clipboard, and loads them back,
  for example into another browser.
- A page too long for one sheet continues on another, under the same heading and with the same
  remarks. Turn it at the curled corner, where "next" or "prev" is scribbled with an arrow. Each
  tab opens on the sheet you left it on.

### Changed

- The worksheet is now the **Flight** page. On the ground, Part I is where you are and Part II the
  airport you pick on the map or job board. In the air, Part I is where you took off from, and
  Part II is your destination, with the job you're flying, until you pick another airport.
- Schedule A is now **Airports**.
- The tabs have no numbers, and each page is numbered within its tab: "Page 1", or "Page 2 of 4".
- The bubbles a job would fill are shaded in pencil.
- Remarks are written smaller, and say only what's about the page. A list's remarks get as many
  lines as they need, and its table fills the rest of the sheet with blank lines.
- What each mark (such as `*`, `+?` and `≈`) and column means is on the Help page, under
  **Marks and columns**.
- Help explains how formation flights count: each pilot's own base pay, with the convoy bonus in
  Net only.
- In the air, your origin's standings are read again if you last landed there on another device.

### Fixed

- Part II no longer goes blank while the job board or a map card sits still, and starts over
  when the game reloads, so it always matches the job the game has picked.
- The landing log script reads an airport's total again when it hasn't risen yet, for up to 15
  minutes. Before, many landings were logged as adding $0.
  `server/repair_zero_landings.py` fixes a log written before then: those landings become
  "pay not known", and landings whose combined rise you know can share it. Give it every company
  with `--co`, once for each.
- Fleet's remarks were cut off when the list filled the sheet.
- A landing of yours could show in the remarks as a rise that wasn't yours ("$0 logged as mine"),
  when the game showed the new total before the landing's report arrived. From a game tab in the
  background, the report can come many minutes after the touchdown.
- Restoring a backup did nothing the first time you chose a file.
- A backup copied through a clipboard that drops some characters (such as a remote desktop's) no
  longer breaks, and a pasted backup that lost characters says so.

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
