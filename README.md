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

- `index.html`: home page (becomes the Camera / Viewer picker in M1–M2)
- `probe.html`: M0 phone check
