# SwingCam: findings on the real iPhone

What worked and what didn't. This guides the later native app.

## Devices

- Camera phone: iPhone 12 Pro Max, iOS 18.7, Safari (UA reports Version/27.0.1)
- Viewer phone: iPhone _?_, iOS _?_, Safari

## M0: phone checks (2026-09-30, at home)

### Camera

- Lenses Safari lists: Back Camera (1×), Back Ultra Wide Camera (0.5×), Back Telephoto Camera,
  plus the virtual Back Dual, Back Dual Wide and Back Triple Camera (these switch lenses on
  their own, so we don't offer them), and the front camera.
- **720p60 works on every back lens.** The camera delivers a full 60 fps (`presentedFrames`).
- **1080p60 drops to 30 fps** on Ultra Wide, Dual Wide and Triple. Only Back Camera, Dual and
  Telephoto keep 60 at 1080p. So: **1280×720 at 60 fps**.
- **The page's main thread misses frames.** `requestVideoFrameCallback` only saw 42–60 fps
  even though the camera produced 60, and it varied run to run (Back Camera 720p: 57.6 fps in one
  run, 44.4 in the next). Anything that reads frames on the main thread will lose some.
- **Frames read in a worker get all 60 fps.** `MediaStreamTrackProcessor` is not available on
  the main thread, but it is in a worker, and a camera track can be transferred to one: 120
  frames in 2 s, a steady 60 fps.
- Frame size follows how the phone is held when the camera opens: 720×1280 in portrait,
  1280×720 in landscape. The app has to handle both, and a rotation mid-session.
- `captureTime` is provided on `requestVideoFrameCallback`, so frame times are on the
  `performance.now()` clock.

### Encoding (WebCodecs)

- H.264 Baseline/Main/High at 720p, High 4.2 at 1080p, and HEVC are all supported.
- Encoding 720p H.264 High took 10.6 ms per frame (95th percentile 12 ms), and the queue never
  backed up (max 0). The encoder is not the bottleneck. In the main-thread test it only reached
  41.5 fps because that's all the main thread handed it.
- 5.3 Mbps at about 42 fps; expect about 6–7 Mbps at 60 fps.
- A 3.5 s cut gave a 3.96 s MP4 (0.46 s lead-in back to the keyframe), 2.6 MB. It played
  smoothly on the phone.

**Decision: WebCodecs H.264 in a worker**, fed by `MediaStreamTrackProcessor`, with the ring
buffer in the worker too. The `<video>` element is only used for the on-screen preview. The
JPEG fallback (59.7 fps at 640×360, 40 KB per frame, about 9 MB for 4 s) works but isn't needed.

### Audio

- 48 kHz. `echoCancellation: false` is honored. Safari doesn't support the `noiseSuppression`
  or `autoGainControl` constraints at all (reported as not supported), so we can't confirm
  whether automatic gain is on. The range recordings will show whether impact peaks get
  squashed.
- **`speechSynthesis` is silent while the mic is capturing.** Web Audio sounds (oscillator
  beeps, decoded WAV clips) still play. Spoken prompts must be audio files.
- **The audio clock stops while the context is suspended or interrupted**, but
  `performance.now()` keeps going. Any audio-to-page clock mapping has to be re-measured after
  every audio pause, or sounds get stamped too early. This broke the first clap test.
- Audio lag: **not measured yet** (no clap trials in the report). This moves into M1, because it
  has to be measured on the worker pipeline the app will actually use.

### Screen, background and storage

- **Wake Lock works**: the screen stayed on for 2 minutes with Auto-Lock set to 30 s.
- **Camera and mic survive Safari going to the background** (tested up to 10 minutes): tracks
  go muted, then unmute on their own when you come back, and the audio context goes
  `interrupted` → `running` by itself. No frames are captured while hidden, so the app must warn.
- **The audio context was suspended for 20 s while the page was visible** (after the test clip
  was played). Playing media on the camera phone can interrupt capture: the app must watch the
  audio context state, resume it, and show a warning if it can't.
- Battery level API: not in Safari (expected). The camera screen can't show battery %.
- Storage: 41 GB quota, not persistent by default (ask with `navigator.storage.persist()`). A
  5 MB Blob saved to and read back from IndexedDB in 31 ms.
- MediaRecorder: `video/mp4;codecs=avc1,mp4a.40.2`.

## M1: camera alone

### Design

- Camera track → cloned and transferred to a worker → `MediaStreamTrackProcessor` →
  `VideoEncoder` (H.264 High 3.2, keyframe every 0.5 s, 6 Mbps) → ring buffer of encoded chunks
  (pre + post + 1.5 s). The `<video>` element only shows the preview.
- Mic → AudioWorklet running the impact detector (`src/audio/detector.js`) on every
  128-sample block.
- All times are on one clock, `performance.timeOrigin + performance.now()`, which is the same in
  the page and in workers. Audio-clock and frame timestamps are mapped onto it with the
  minimum offset over the last second (see `ClockMapper`).
- On a trigger: impact time = trigger time − audio lag setting. The clip is cut 0.4 s after its
  end time, from the keyframe before (impact − pre), and muxed to MP4 in the worker.

### Checked on the PC (Chromium, video-file test mode, synthetic recording)

- End to end: impacts at 3, 7 and 12 s saved as swings 1–3; the one at 8 s was ignored (within
  3 s); a voice-like hum was ignored ("slow rise"). Clips were ready about 1.9 s after impact.
- **Bug found and fixed:** after digital silence (mic starting, iOS resuming audio), the
  background estimate started at −120 dB and rose only slowly, so the room noise itself
  triggered, and real impacts were then ignored for 3 s. Now the background jumps to the new
  level after silence, follows quickly for 0.5 s, and nothing triggers during that time.
- In this browser's file playback, the flash in the video was 42–50 ms before the marked
  impact, steady across clips. That steadiness is what the audio-lag calibration relies on.
- Low-bitrate Opus audio (MediaRecorder's default) blunted the synthetic impacts by about 25 dB.
  Recordings used for tuning should keep good audio quality (the iPhone's AAC is fine).
- `requestAnimationFrame` doesn't run while a page isn't painted; anything that must keep running
  uses timers or workers instead.

### On the iPhone (2026-10-01, at home, portrait, claps and taps)

- **Full 60 fps through the worker**: clips had 212–238 frames for 3.5–4.0 s. (The main-thread
  route in M0 only managed 42–57.)
- Clips were ready **1.9 s after impact**, every time (13 swings).
- **Audio lag measured with the clap test: +25 ms** (the mic hears things 25 ms after the camera
  sees them; about 6 ms of that is sound travelling 2 m).
- Quiet room: background about −78 dBFS (treble peak), claps and taps −35 to −58 dBFS, 20–40 dB
  over background. The mic level is low; worth watching whether real impacts sit well above the
  −60 dB "too quiet" floor.
- **Clips came out sideways.** In portrait the preview track is 720×1280, but frames read in the
  worker are 1280×720 and have no `rotation` property. Safari rotates only the preview. Fix: compare
  a 32×32 snapshot of the preview with the worker frame at each rotation and write the best match
  into the MP4 (`src/camera/orientation.js`). Native app note: handle orientation explicitly.
- `speechSynthesis` silence and audio-clock pauses: see M0. The WAV-clip countdown works.

## Checked on the PC

WebCodecs H.264 with a keyframe every 0.5 s, cutting from the keyframe before the start point,
and saving to MP4 with Mediabunny all work in Chromium on Windows.
