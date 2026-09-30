# SwingCam web prototype: project brief for Claude Code

## What we're building

A web app for the golf range that turns an old iPhone into a camera that records swings on its own. The camera phone sits on a tripod, listens for the sound of the club hitting the ball, and saves a short clip of each swing. The clip is sent to the golfer's own iPhone, where they review it in slow motion.

This prototype has one job: prove that **sound-triggered auto-capture** and **phone-to-phone clip transfer** work at a real driving range. Swing analysis (pose tracking, fault detection, drills) is **out of scope** for now. So are accounts and cloud storage.

## Hardware and environment

- **Camera phone:** iPhone 12 Pro Max, current iOS, Safari, no SIM card. At the range it joins the viewer phone's Personal Hotspot.
- **Viewer phone:** the owner's current iPhone, running Safari.
- Hosted on a secure (HTTPS) site, which Safari requires for camera and mic access. Use GitHub Pages or Netlify, whichever is simpler to set up. Walk me through that step.
- I'm not a professional developer. Explain setup steps plainly, and keep the stack simple.

## Core user flow

1. Both phones open the same link. One taps **Camera**, the other taps **Viewer**.
2. The camera shows a short pairing code (like `GOLF-42`). The viewer types it in, and the phones connect.
3. **Camera mode:**
   - Shows a live preview with a framing outline for a golfer.
   - Lets me choose which back lens to use (wide or ultra-wide) if Safari lists them.
   - Has a big **Arm** button. Once armed, it records into a rolling buffer, keeps the screen awake, and shows status: armed, clips captured, battery if available.
4. When the camera hears impact, it saves a clip from **2.0 s before to 1.5 s after** the impact and sends it to the viewer. Both settings should be adjustable.
5. **Viewer mode:**
   - Each new clip appears within about 10 s, numbered ("Swing 14"), with an optional club tag.
   - Playback supports 1×, 0.5×, and 0.25× speed, frame-by-frame stepping, and a scrubber, with the impact frame marked.
   - Two clips can be compared side by side.
   - Clips can be downloaded to the phone.
6. Viewer buttons for testing: **"Missed a swing"** and **"False trigger"**. They build a session log (swings hit, clips captured, false triggers, how long each clip took to arrive) that I can export as a CSV.

## Technical guidance (confirm on the real phone first)

**Rolling buffer.** Safari's camera runs at 30–60 fps in a web page, not the 240 fps of the Camera app. That's accepted for this prototype. Ask for 60 fps at 1280×720 and show the frame rate actually delivered.

- **Preferred approach:** WebCodecs `VideoEncoder` (H.264), with a keyframe about every 0.5 s. Keep the encoded pieces in a time-stamped ring buffer about 4 s long. On a trigger, cut from the keyframe just before the start point and save to MP4 with a small library such as `mp4-muxer`.
- **Fallback if WebCodecs is unreliable on iOS:** a ring buffer of downscaled JPEG frames captured with `requestVideoFrameCallback`. Watch memory closely with this one.
- Don't rely on cutting `MediaRecorder` output mid-stream, because iOS doesn't produce pieces that play on their own.

**Impact detection** (Web Audio, `AudioWorklet` if possible):

- Watch for a sharp spike in loudness: a peak well above the room's running background noise, with a fast rise, ideally weighted toward high frequencies. A club hitting a ball is a sharp "crack", unlike voices or wind.
- After a trigger, ignore new sounds for about 3 s.
- Provide a sensitivity slider and a live sound-level meter so I can tune it at the range.
- Add a small adjustable offset for the timing lag between audio and video.
- Log every trigger with its peak level so false triggers can be tuned out later.

**Pairing and transfer:**

- Connect the phones directly with WebRTC data channels. PeerJS with its free connection server is fine, since the hotspot provides internet.
- Send clips in small chunks and have the viewer confirm receipt.
- Keep unconfirmed clips on the camera phone (IndexedDB) and resend them after a reconnect.

**iOS quirks to handle:**

- Camera, mic, and audio must start from a user tap.
- Keep the screen awake with the Wake Lock API.
- If Safari goes to the background, warn me with a clear message and recover when I come back.
- No permission prompts in a loop.

**Desktop test mode:** the camera mode should also accept a video file (with audio) instead of the live camera. That lets me test the detector with range recordings at home.

## Milestones (stop and let me test on the phones after each one)

- **M0: check on the actual phone.** A tiny test page that reports:
  - frame rates and resolutions actually delivered, for each lens,
  - whether WebCodecs H.264 encoding works,
  - whether the Wake Lock API works,
  - how much audio lag there is.

  Use the results to choose the buffer approach.
- **M1: camera alone.** Rolling buffer, impact trigger, and a clip that plays back on the same phone.
- **M2: two phones.** Pairing code, clip transfer with confirmation, and resend after a reconnect.
- **M3: viewer tools.** Slow motion, frame stepping, side-by-side view, club tags, download, session log and CSV export.
- **M4: deploy and field test.** HTTPS hosting, a one-page "how to use at the range" checklist, and battery-drain notes.

## Done means (the gate for moving on)

- **Capture rate:** at least 95% of real swings captured, and no more than 1 false trigger per 20 swings at a moderately busy range, after tuning.
- **Speed:** clips reach the viewer within about 10 s.
- **Reliability:** runs a 60-minute session without crashing or losing clips.
- **Setup:** the camera phone is running within 60 seconds.

## How to work with me

- Start by reading this brief, asking me any questions, and proposing a plan and file structure before writing code.
- Keep the code in a git repo with clear commits for each milestone.
- Prefer plain JavaScript or TypeScript with Vite, with minimal dependencies. No framework unless it clearly helps.
- Write small tests for the impact detector using recorded audio samples.
- Keep a `NOTES.md` of what worked and what didn't on the real iPhone. Those findings will guide the native iPhone app later (which would get 240 fps, a direct phone-to-phone link, and Apple's built-in body tracking).
