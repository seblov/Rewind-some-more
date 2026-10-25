# Rewind 1.7.1

**Now available for Linux as well.** Windows x64 and Linux x64. There is no ARM or
32-bit build, and no macOS build.

## Linux

The first Linux builds are here: an AppImage and a Debian package. They use
ffmpeg and PulseAudio rather than the OBS engine the Windows app ships.

- X11 desktops only. Wayland needs the PipeWire portal and is not supported yet.
- Requires `pactl` (PulseAudio or PipeWire) and `wmctrl`.
- Software x264 encoding. Hardware NVENC, AMF and QSV are not used.
- In-app updates are off on Linux.

What works: display and window capture, the rolling replay buffer, quick clips,
continuous recording, screenshots, the clip library, the editor (trim, cut,
reorder, waveforms, per-track volume), compression and sized exports, profiles,
hotkeys, and per-app faders.

Install the Debian package with `sudo apt install ./Rewind-1.7.1-amd64.deb`, or
save the AppImage, make it executable with `chmod +x`, and run it. The first
launch creates the library in `~/Videos/Rewind`.

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

- `Rewind-1.7.1-amd64.deb`, the Debian package for x86-64. Installs to
  `/opt/Rewind` and adds a desktop entry.
- `Rewind-1.7.1-x86_64.AppImage`, the portable Linux build. X11, x86-64.
- `Rewind-1.7.1-setup.exe`, per-user Windows installer, no admin required.
- `Rewind-1.7.1-setup.exe.blockmap`, required for in-app updates.
- `latest.yml`, the Windows update feed. Required for in-app updates.
- `Rewind-1.7.1-portable.zip`, unpack anywhere and run `Rewind.exe`. No installer,
  no registry entry, and the in-app updater is off.
