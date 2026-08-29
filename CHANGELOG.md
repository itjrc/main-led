# Changelog

All notable changes to OBS Main LED are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-08-28

### Changed

- **Media conversion keeps the source quality.** Non-MP4 videos were re-encoded
  to H.264 baseline with one reference frame, a fixed 4915k bitrate and a
  forced 30 fps - a hardware-player preset that re-compressed every clip to
  about 5 Mbps and dropped half the frames of 50/60 fps material. They are now
  encoded at CRF 18 (high profile, slow preset), keeping the original
  resolution, frame rate and aspect. Files come out bigger, which is the trade.
- Images converted to 5 s clips are written at CRF 16 with `-tune stillimage`
  instead of x264's default CRF 23, and scaled with lanczos rather than
  bilinear, so gradients no longer band and small text stays sharp.

## [1.3.0] - 2026-08-26

### Added

- **Partner logo sync**: a new *Partner Logos* panel in LED Control fills
  `data/PARTNERS_LOGO/` - the folder the `Partners Logo` slideshow reads - from
  the tournament partners page. The folder is fetched automatically the first
  time the panel finds it empty, and *Sync from itjr.ca* re-runs it on demand.
- Logos are read from the site's partner data rather than the page markup: the
  partners page renders client-side, so its HTML carries template placeholders
  instead of logos. The data also gives the display order and excludes the
  dignitary headshots kept in the same asset folder.
- SVG logos are rasterized to 1024px PNG through a hidden Chromium window, since
  an OBS slideshow reads PNG/JPEG/BMP/GIF/WEBP but never SVG.
- A sync mirrors the site: logos it no longer lists are moved to a `REMOVED/`
  subfolder rather than deleted, and files added to the folder by hand are left
  alone and reported separately in the panel.
- After a sync that changed anything, a connected OBS has the slideshow
  re-pointed at the folder so new logos show without restarting OBS.
- Unchanged logos are skipped on later syncs by comparing a hash of the file as
  the site serves it, so an untouched SVG is never rasterized twice.

## [1.2.0] - 2026-08-26

### Added

- Clips now play their **full length**: real durations are read with ffprobe
  and the rotation advances when a clip ends instead of cutting it on a fixed
  timer.
- Clips are split into **duration-balanced batches** of "Videos between
  scores" (longest-first greedy assignment), so every batch runs about the
  same total time. Batches are reshuffled at every automation start.
- **Playback plan panel** in LED Control: shows each batch with its clips,
  per-clip and total durations, the score blocks in between, and a 🔴 marker
  that follows what is on air.
- **Automatic media file-name cleanup** before every conversion and sync:
  Unicode normalization (accents kept), no-break spaces, curly quotes,
  percent signs (ffmpeg reads them as frame patterns) and Windows-forbidden
  characters, with `(2)` suffixes on collisions.
- **Single OBS instance**: the main process refuses a second launch while OBS
  runs, and the Launch OBS button stays disabled for OBS's whole lifetime.
- The OBS **canvas and output resolutions are forced to 1920x1080** (the LED
  board size) in the profile at launch and re-checked over WebSocket at every
  connection.
- The **fit-to-screen transform** (scale-inner 1920x1080) is re-applied to
  every LOOP_IND clip at every sync, in both the live and offline paths, so a
  hand-moved clip snaps back to full screen.

### Changed

- The score rotation only cycles the SCORES scene's **browser_source
  webpages**; other elements (rain-delay text banners toggled by hand) keep
  their manual visibility.
- The video rotation **pauses during score sequences** and resumes with the
  next batch when the scores hand the program back.
- The first video starts **immediately** on Start Automation instead of after
  one full interval.
- The "Video duration (ms)" setting became **"Fallback duration (ms)"**: it
  only applies to clips whose real duration cannot be read.
- LED Control layout reworked: the Playback plan gets its own scrolling
  column, and the Activity Log moved next to the Media Library.
- LOOP_IND is rebuilt with a canonical item transform when the scene
  collection is installed, so a hand-modified clip cannot become the template
  for the whole folder.

### Fixed

- Scores were silently skipped: the automation looked for sources whose name
  contains "SCORE", which matched none of the shipped displays.
- Clips were cut mid-play by the fixed rotation timer.
- The OBS canvas defaulted to the monitor's resolution on fresh profiles,
  breaking every 1920x1080 transform in the collection.

### Removed

- Studio Mode: the launch flag is gone and the mode is actively disabled at
  connection and in the stored OBS configuration.
- `TUTORIEL.md`.

## [1.1.2] - 2026-08-25

### Fixed

- The LED Control tab stayed locked on machines without a standalone Node.js
  install. The app runs on the Node runtime embedded in Electron, so the
  Setup gate no longer probes for a `node` executable.

## [1.1.1] - 2026-08-21

### Added

- Application logo.

## [1.1.0] - 2026-08-20

First packaged release.

### Added

- One-click **Launch OBS**: rewrites media paths, imports the scene
  collection, enables the obs-websocket server with the UI credentials and
  starts OBS portable on the right collection.
- **Media Library panel**: folder picker, stats (count, durations, size),
  automatic conversion of images and non-MP4 videos to MP4, LOOP_IND kept in
  mirror of the folder whether OBS is running (live WebSocket sync) or not
  (collection file rewrite), and an optional folder watchdog.
- Converted source files are archived to `ORIGINAL/` instead of deleted.
- Scores automation with configurable intervals, plus manual scene controls.
- Clean OBS shutdown that avoids the safe-mode prompt on the next launch.
- Windows artifact packaged in CI; a GitHub release is published on `v*`
  tags.
- Application version shown in the header.

[1.3.1]: https://github.com/itjrc/main-led/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/itjrc/main-led/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/itjrc/main-led/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/itjrc/main-led/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/itjrc/main-led/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/itjrc/main-led/releases/tag/v1.1.0
