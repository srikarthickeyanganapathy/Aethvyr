# Phase 7 · Aethvyr Audio

Studio → Audio offers Flat, Cinema, Voice, Night, Music, Bass and a persistent five-band Custom EQ. Flat retains the legacy normal identifier. Existing band frequencies, custom gains, pitch preference and delay settings remain compatible. Unity gain is the default. Studio shows a listening-volume warning above 150% boost.

## Signal path

The player owns one media-element source per graph. Audio passes through lip-sync delay, EQ, optional programme compression, boost, optional RMS-based gain correction, spatial processing and channel routing. Boosted or enhanced output then passes through a peak compressor and a bounded sample shaper. Flat at unity bypasses output limiting. Sample limiting cannot establish a safe acoustic listening level. Loudness correction uses gated RMS rather than integrated programme LUFS.

Zero stereo width now mixes the sides equally. Neutral width bypasses the spatial stage. Switching between stereo, mono and isolated channels detaches the previous input branch. Voice emphasizes the presence band, Night compresses dynamics, and the dialogue control independently lifts the center band. Pitch preservation uses the media element. Audio-only continues to suspend GPU playback and prefer an audio-only or low-bandwidth variant where available. The legacy black-frame detector sleeps in audio-only mode.

## Lecture listening

Enable silence acceleration per player session. Threshold, quiet duration and speech padding are adjustable. The player checks levels on its existing 250 ms tick, accelerates to 2× after sustained silence, and restores the previous rate on speech. A short replay around the last quiet observation protects speech onset. Turning the switch off restores speed immediately. Seeking resets detection. Suspended audio, muted playback, live streams and active loops disable acceleration. Faint music and short speech between samples are limitations of level-based detection.

## Verification

The Edge 158 Chromium fixture rendered a generated left-channel 1 kHz tone at 48 kHz through each production preset, with a 50 ms lip-sync offset. Left isolation produced identical output on both speakers. Flat at unity produced a 0.900 sample peak and 50 ms delay. With 300% boost, the six other configurations produced peaks from 0.913 to 0.978 and 62 ms delay. These measurements include graph processing and exclude hardware output latency. The fixture exercised preset changes, spatial bypass, graph reuse and release. The browser playback fixture additionally checked speed changes, playback and native restoration.

Run the Chromium foundation fixture with --audio after building. Unit tests cover silence thresholds, speech padding, speed restoration and imported bounds. Firefox packaging was validated. Physical headphone output, perceived dialogue quality, device latency and audiovisual sync on individual devices require listening tests.
