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

## Checked on the PC

WebCodecs H.264 with a keyframe every 0.5 s, cutting from the keyframe before the start point,
and saving to MP4 with Mediabunny all work in Chromium on Windows.
