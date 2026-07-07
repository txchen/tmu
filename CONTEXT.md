# TMU

TMU is a lean terminal music player effort focused on efficient everyday playback across local and remote music sources.

## Language

**TMU**:
The working name for the new lean TUI music player being planned in this repository.
_Avoid_: cliamp clone, lightweight cliamp

**Navidrome**:
A self-hosted music server that TMU should integrate with through the Subsonic/OpenSubsonic client API surface.
_Avoid_: navidrone

**Provider**:
A source of playable music and metadata, such as a local music library, Navidrome server, YouTube Music account, or offline YouTube download cache.
_Avoid_: backend, source

**Offline YouTube Cache**:
The local library of audio files and metadata created by downloading YouTube or YouTube Music items before playback inside TMU. In the MVP, YouTube playback goes through this cache instead of live streaming from YouTube.
_Avoid_: download folder, saved YouTube

**Low-Power TUI**:
The UI constraint that terminal rendering must be event-driven and bounded, with no always-on visualizers or high-frequency EQ displays in the MVP.
_Avoid_: efficient UI, battery friendly UI

**Queue-First MVP**:
An MVP shape where every Provider feeds a single playback queue, and browsing/search exists only to add playable items to that queue.
_Avoid_: library-browser-first MVP, media manager MVP

**Navidrome Library Browser**:
The MVP browsing surface for a Navidrome Provider, covering artist and album navigation well enough to enqueue tracks from a remote music library.
_Avoid_: Navidrome playlist-only mode
