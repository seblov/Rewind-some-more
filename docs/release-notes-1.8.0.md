# Rewind 1.8.0

**A longer buffer, and clips that fit Discord.** The replay buffer now holds up
to 30 minutes, and Compress has a goal that lands a clip under Discord's free
upload limit.

## A 30-minute buffer

- **10m** and **30m** join the buffer limit strip. The custom field accepts any
  window from 5 seconds to 30 minutes.
- One constant sets the ceiling. The deck, the profiles table, the main-process
  validator and the Linux recorder's free-space check all read it, so they cannot
  disagree.
- The Linux recorder asks for room for the longest window at the highest bitrate
  before it puts the ring in shared memory, and falls back to the temp folder when
  the machine does not have it.

## Discord compression goal

- **Discord** joins Low, Medium and High in the Compress bar. It targets 49.9 MB, a
  hair under the 50 MB free limit, and the readout shows the size and the saving
  before you commit.
- The goal is a ceiling. A single GPU pass can land above its asked bitrate, so the
  export measures the file and re-encodes lower when it overshoots.
- A clip that already fits is not inflated. The goal never spends more bitrate than
  High would.
- A range too long to fit 49.9 MB at a watchable bitrate disables the button and the
  readout says so.

## Also in this build

- The Compress bar wraps its action to a second, right-aligned line when the
  settings no longer fit beside it, instead of squeezing the scope text to nothing.
- The deck's buffer limit row wraps on short windows.

## Assets

- `Rewind-1.8.0-setup.exe`, the per-user Windows installer. No admin required.
- `Rewind-1.8.0-setup.exe.blockmap`, required for in-app updates.
- `latest.yml`, the Windows update feed. Required for in-app updates.
- `Rewind-1.8.0-portable.zip`, unpack anywhere and run `Rewind.exe`.
- `Rewind-1.8.0-amd64.deb`, the Debian package for x86-64. Installs to `/opt/Rewind`.
- `Rewind-1.8.0-x86_64.AppImage`, the portable Linux build. X11, x86-64.

Linux requires `pactl` (PulseAudio or PipeWire) and `wmctrl`. The Linux build uses
software x264 encoding and does not use the in-app updater.
