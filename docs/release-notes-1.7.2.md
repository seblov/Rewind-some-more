# Rewind 1.7.2

**More audio channels.** Extra output and input devices added in Settings → Audio
now record on their own audio tracks, so each one can be mixed separately in the
clip editor.

## Audio channels

- Every added device gets its own track instead of being folded into one combined
  device track. The editor shows a separate lane, waveform and volume for each.
- The channel count follows the device list in Settings → Audio. Rewind accepts up
  to eight extra devices.
- **Windows:** OBS records at most six audio tracks. Mix, Desktop and Microphone use
  tracks 1 to 3, so the first three added devices take tracks 4, 5 and 6. A fourth
  and later device share track 6.
- **Linux:** the recorder has no six-track limit, so every added device gets its own
  stream and label.

## Also in this build

- Linux draws its own minimize, maximize and close buttons.
- "Buffer started" and "Buffer paused" replace the old Recording wording.
- The deck fits short windows and shows a scrollbar when it needs one.
- "Replace original" in the editor asks before overwriting the clip.
- Helper text and danger buttons meet contrast targets in all three themes.
- Settings says "System Default" rather than "Windows Default".

## Assets

- `Rewind-1.7.2-setup.exe`, the per-user Windows installer. No admin required.
- `Rewind-1.7.2-setup.exe.blockmap`, required for in-app updates.
- `latest.yml`, the Windows update feed. Required for in-app updates.
- `Rewind-1.7.2-portable.zip`, unpack anywhere and run `Rewind.exe`.
- `Rewind-1.7.2-amd64.deb`, the Debian package for x86-64. Installs to `/opt/Rewind`.
- `Rewind-1.7.2-x86_64.AppImage`, the portable Linux build. X11, x86-64.

Linux requires `pactl` (PulseAudio or PipeWire) and `wmctrl`. The Linux build uses
software x264 encoding and does not use the in-app updater.
