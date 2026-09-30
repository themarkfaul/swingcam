# SwingCam: findings on the real iPhone

What worked and what didn't. This guides the later native app.

## Devices

- Camera phone: iPhone 12 Pro Max, iOS _?_, Safari
- Viewer phone: iPhone _?_, iOS _?_, Safari

## M0: phone checks

_Not run on the iPhone yet._

Checked on a Windows PC (Chromium, generated frames, no camera): the WebCodecs H.264
encoder with a keyframe every 0.5 s, cutting from the keyframe before the start point,
and saving to MP4 with Mediabunny all work. A 3.5 s cut at 720p60 came out 4.0 s long
(0.48 s of lead-in back to the keyframe) and 0.68 MB, and opens in a `<video>`.
