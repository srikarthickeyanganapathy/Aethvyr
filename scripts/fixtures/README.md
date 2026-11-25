# MP4 seek fixtures

These silent H.264 video and mono AAC files were generated from FFmpeg's test-pattern and sine sources.
They contain approximately 12 seconds of media in four-second fragments. The regression test supplies
a deliberately short movie header before finalizing the export.

```sh
ffmpeg -f lavfi -i 'testsrc2=size=64x48:rate=10:duration=12' -an -c:v libx264 -preset ultrafast -b:v 20k -pix_fmt yuv420p -g 40 -keyint_min 40 -sc_threshold 0 -movflags +frag_keyframe+empty_moov+default_base_moof seek-video.mp4
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=16000:duration=12' -vn -c:a aac -b:a 16k -frag_duration 4000000 -movflags +empty_moov+default_base_moof seek-audio.m4a
```
