# Range recordings for detector tests

Put each recording here as a WAV file with a label file beside it:

- `range-1.wav`: the sound
- `range-1.json`: when the real impacts (your swings) happen, in seconds from the start

```json
{
  "impacts": [12.41, 47.03, 81.9],
  "toleranceS": 0.05,
  "params": { "thresholdDb": 20 }
}
```

`params` is optional and overrides the detector defaults for that recording. Other golfers'
impacts are left out of `impacts` on purpose: if the detector triggers on them, the test
reports them as false triggers.
