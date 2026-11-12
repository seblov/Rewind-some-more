# Rewind 1.8.3

**Rename a clip where you edit it, and click the ruler to move the playhead.**

## Rename in the editor

- Click the clip name in the editor header to rename it. Enter or clicking away
  keeps the name, Escape discards it.
- Save a copy writes `<new name>.mp4` beside the clip. A name that is already in
  use gets `-2`, `-3`, so nothing is overwritten.
- Replace original writes the edit under the new name and removes the file it
  replaced. It refuses, before writing anything, if another clip already has that
  name.
- The renamed file keeps its recorded time, source and audio track labels in the
  library, and the old name's entry is dropped.

## Seek from the ruler

- The time ruler above the audio lanes is now a click target, on the same scale as
  the lanes below it. Click anywhere on it to jump the playhead there.
- Wheel scrub, drag to mark a range, and the trim handles are unchanged.

## Also in this build

- Closing the editor with an unsaved name asks before discarding it, the same way
  unsaved cuts do.

## Assets

- `Rewind-1.8.3-setup.exe`, the per-user Windows installer. No admin required.
- `Rewind-1.8.3-setup.exe.blockmap`, required for in-app updates.
- `latest.yml`, the Windows update feed. Required for in-app updates.
- `Rewind-1.8.3-portable.zip`, unpack anywhere and run `Rewind.exe`.
