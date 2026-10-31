# Rewind 1.8.2

**The save bar shows a real percentage.** Saving an edit now reports how far the
encoder has got, instead of a bar that only said something was happening.

## Progress you can read

- Save a copy and Replace original show the encoder's own position, taken from the
  ffmpeg process that writes the clip, and the number beside it.
- A stream copy fills as each piece is written, then as the pieces are joined. A
  re-encode fills once across the whole write.
- Compress keeps the percentage it already had. Both bars are the same control.

## Also in this build

- A save that keeps the whole clip still reports completion, because a plain file
  copy has no intermediate position to read.
- The bar stops at 99% until the write returns, rather than claiming the file is
  finished while it is still being renamed into place.

## Assets

- `Rewind-1.8.2-setup.exe`, the per-user Windows installer. No admin required.
- `Rewind-1.8.2-setup.exe.blockmap`, required for in-app updates.
- `latest.yml`, the Windows update feed. Required for in-app updates.
- `Rewind-1.8.2-portable.zip`, unpack anywhere and run `Rewind.exe`.

Linux requires `pactl` (PulseAudio or PipeWire) and `wmctrl`. The Linux build uses
software x264 encoding and does not use the in-app updater.
