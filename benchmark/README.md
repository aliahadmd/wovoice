# WoVoice personal accuracy benchmark

Record each prompt in `utterances.json` as a mono 16 kHz PCM WAV named
`01.wav` through `30.wav`. Use the phone in your normal speaking voice: 20 in a
quiet room and 10 with mild everyday background noise, as marked in the file.

Run the same recordings against each staging deployment:

```sh
WOVOICE_WORKER_URL=https://your-staging-worker.workers.dev \
WOVOICE_DEVICE_TOKEN=your-device-token \
node benchmark/run.mjs benchmark/audio
```

The runner prints aggregate word error rate, punctuation F1, and critical
name/number recall without uploading or storing anything beyond the request
needed for each transcription. Review every changed sentence manually and
reject any model/cleanup configuration that changes meaning.

Selection: lower WER wins; within one percentage point, higher punctuation F1
wins; if still tied, use Whisper.
