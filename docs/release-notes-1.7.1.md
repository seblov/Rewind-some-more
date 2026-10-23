# Rewind 1.7.1

Windows x64 only. No ARM, no 32-bit, no Linux or macOS build.

## What's new since 1.7.0

**Cutting is one drag and one click.** Drag across the timeline to mark the footage
you want gone, then press **Cut out** (or Delete). The marked range is removed and
the sequence closes up behind it. Undo restores it.

The old **Cut** button only split the piece under the playhead, which looked like
nothing had happened. It is now **Split** and still answers to C and Ctrl+K. A piece
can still be selected and cut out or lifted exactly as before.

Also in this build:

- The timeline draws the marked range as an accent band, and the Cut out button shows
  its length, for example "Cut out 3.0s".
- A short hint above the timeline explains the drag until the first edit.
- A plain click dismisses the range. Undo, redo, a trim and any edit clear it.
- The range is frame-snapped, and the preview lands on the join frame after the cut.

## Assets

- `Rewind-1.7.1-setup.exe`, per-user installer, no admin required.
- `Rewind-1.7.1-setup.exe.blockmap`, required for in-app updates.
- `latest.yml`, the update feed the app reads. Required for in-app updates.
- `Rewind-1.7.1-portable.zip`, unpack anywhere and run `Rewind.exe`. No installer,
  no registry entry, and the in-app updater is off.
