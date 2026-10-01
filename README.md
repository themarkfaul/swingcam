# SwingCam web prototype

Turns an old iPhone into a sound-triggered swing camera. See
[swingcam-web-prototype-brief.md](swingcam-web-prototype-brief.md) for the goals and
[NOTES.md](NOTES.md) for what we've learned on the real phones.

Live site: https://themarkfaul.github.io/swingcam/

## Everyday commands

Run these in PowerShell inside this folder. If PowerShell complains that running
scripts is disabled, type `npm.cmd` instead of `npm`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the site on this PC at http://localhost:5173 (no camera on iPhone; that needs HTTPS) |
| `npm test` | Runs the detector tests |
| `npm run build` | Builds the site into `dist/` |

Pushing to the `main` branch on GitHub publishes the site automatically (about a minute).

## Pages

- `index.html`: home page (Camera / Viewer picker)
- `camera.html`: Camera mode (M1). Also has a video-file test mode for the PC.
- `probe.html`: M0 phone check

## Code map

| Folder | What's there |
| --- | --- |
| `src/audio/` | The impact detector (plain code, tested in `test/`), its AudioWorklet wrapper, and the mic listener |
| `src/camera/` | Camera page, encoder worker, ring buffer, clap calibration |
| `src/media/` | MP4 muxing (Mediabunny) |
| `src/shared/` | Clock, settings, wake lock, voice prompts, debug log, file saving |
| `src/probe/` | M0 phone check |
| `test/` | Detector, ring buffer and clock tests. Real range recordings go in `test/fixtures/` |
