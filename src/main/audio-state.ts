import { getSetting } from './store.js'
import type { AudioChannel, AudioLevel } from '@shared/types.js'

/**
 * Channel bindings and levels.
 *
 * Read by both capture backends: Windows hands these to OBS sources, Linux hands
 * them to the ffmpeg filters. Keeping them here means neither backend owns the
 * shape of the settings.
 */

export function channelDevices(): Record<AudioChannel, string> {
  return {
    desktop: getSetting('desktopDeviceId'),
    microphone: getSetting('micDeviceId'),
  }
}

export function channelLevel(channel: AudioChannel): AudioLevel {
  return channel === 'desktop'
    ? { volume: getSetting('desktopVolume'), muted: getSetting('desktopMuted') }
    : { volume: getSetting('micVolume'), muted: getSetting('micMuted') }
}
