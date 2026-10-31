# Rewind 1.8.1

**Saving an edit shows it is still working.** The editor draws a progress bar
while it writes a clip, and the panel stops ticking once a second while it sits
in the tray.

## A bar while a clip saves

- Save a copy, Replace original and Compress now show a bar in the editor footer
  or beside the size readout. A save that re-encodes can run for minutes, and a
  window with dead buttons reads as a frozen app.
- Compress keeps its exact percentage; the save bar is an activity bar, because
  the encoder does not report how far along it is.
- The bar is drawn from the theme's own tokens, so it takes Graphite's indigo,
  Terminal's green and Grotesk's blue without a separate style per theme.

## Less work while the panel is hidden

- The held-seconds tick and the dial's resting animation stop while the window is
  hidden in the tray, and catch up on the next visible frame.
- The tick moved from the deck into the dial, so a fill step no longer re-renders
  the actions, the buffer limit chips and the profile row.
- Settings → Audio shares one device inventory query between the desktop and
  microphone editors. Each editor used to enumerate every endpoint on its own
  poll, and enumerating creates and releases a probe source inside OBS.

## Also in this build

- Enabling extra audio channels enumerates endpoints once per pass rather than once
  per added channel.
- The app list no longer enumerates a device list it never reads.
- The clip rail passes the row index the virtualizer needs, so row measurement
  applies instead of being refused with a warning.

## Assets

- `Rewind-1.8.1-setup.exe`, the per-user Windows installer. No admin required.
- `Rewind-1.8.1-setup.exe.blockmap`, required for in-app updates.
- `latest.yml`, the Windows update feed. Required for in-app updates.
- `Rewind-1.8.1-portable.zip`, unpack anywhere and run `Rewind.exe`.

Linux requires `pactl` (PulseAudio or PipeWire) and `wmctrl`. The Linux build uses
software x264 encoding and does not use the in-app updater.
