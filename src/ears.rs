//! Listening: microphone -> voice detection -> recognition, reported as events.
//!
//! `speech` the moment a voice is heard (and we stop talking), then either `heard` with the
//! words once the speaker pauses, or `quiet` if it was only a noise.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::json;
use sherpa_onnx::{
    LinearResampler, OfflineRecognizer, OfflineRecognizerConfig, SileroVadModelConfig, VadModelConfig,
    VoiceActivityDetector,
};

use crate::sound::{CHIME_RATE, Chimes, Speaker};
use crate::voice::Voice;
use crate::{event, mic, models};

const RATE: i32 = 16_000;
const BLOCK: usize = 512; // one Silero window, 32 ms

pub struct Ears {
    pub on: Arc<AtomicBool>,
    /// Still hearing (for the words that end the pause), but out of the way: no chimes, and
    /// speech is not cut off when someone talks.
    pub paused: Arc<AtomicBool>,
    pub silence: f32,
    pub chimes: bool,
}

impl Ears {
    /// Runs for the life of the process. The microphone is open only while `on` is set.
    pub fn run(self, voice: Voice, speaker: Speaker) -> Result<()> {
        let vad_path = models::vad()?;
        let asr_dir = models::recognizer()?;
        let file = |name: &str| Some(asr_dir.join(name).to_string_lossy().into_owned());

        let mut vad_config = VadModelConfig::default();
        vad_config.silero_vad = SileroVadModelConfig {
            model: Some(vad_path.to_string_lossy().into_owned()),
            threshold: 0.5,
            min_silence_duration: self.silence, // this much quiet ends the turn
            min_speech_duration: 0.2,
            window_size: BLOCK as i32,
            max_speech_duration: 30.0,
        };
        vad_config.sample_rate = RATE;
        let vad = VoiceActivityDetector::create(&vad_config, 60.0).context("voice detection failed to load")?;

        let mut asr_config = OfflineRecognizerConfig::default();
        asr_config.model_config.transducer.encoder = file("encoder.int8.onnx");
        asr_config.model_config.transducer.decoder = file("decoder.int8.onnx");
        asr_config.model_config.transducer.joiner = file("joiner.int8.onnx");
        asr_config.model_config.tokens = file("tokens.txt");
        asr_config.model_config.model_type = Some("nemo_transducer".into());
        asr_config.model_config.num_threads = 4;
        let recognizer = OfflineRecognizer::create(&asr_config).context("recognizer failed to load")?;
        let transcribe = |samples: &[f32]| -> String {
            let stream = recognizer.create_stream();
            stream.accept_waveform(RATE, samples);
            recognizer.decode(&stream);
            stream.get_result().map(|r| r.text.trim().to_string()).unwrap_or_default()
        };

        let chimes = Chimes::new(0.16);
        event(json!({ "event": "ears-ready" }));

        loop {
            while !self.on.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50));
            }
            let (samples, incoming) = channel();
            let microphone = mic::open(samples)?;
            let resampler = LinearResampler::create(microphone.rate as i32, RATE).context("resampler")?;
            event(json!({ "event": "listening", "echo_cancelled": microphone.echo_cancelled }));
            vad.reset();

            let mut pending: Vec<f32> = Vec::new();
            let mut preroll: VecDeque<Vec<f32>> = VecDeque::new(); // audio just before the voice
            let mut utterance: Option<Vec<f32>> = None;
            let (mut heard, mut chimed) = (0usize, false);

            while self.on.load(Ordering::SeqCst) {
                let chunk = match incoming.recv_timeout(Duration::from_millis(100)) {
                    Ok(chunk) => chunk,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => break,
                };
                // without echo cancellation we would hear ourselves: stay deaf while talking
                if !microphone.echo_cancelled && voice.speaking.load(Ordering::SeqCst) {
                    pending.clear();
                    preroll.clear();
                    utterance = None;
                    vad.reset();
                    continue;
                }
                pending.extend(resampler.resample(&chunk, false));
                while pending.len() >= BLOCK {
                    let block: Vec<f32> = pending.drain(..BLOCK).collect();
                    vad.accept_waveform(&block);
                    let speaking = vad.detected();

                    if utterance.is_none() {
                        if !speaking {
                            preroll.push_back(block);
                            if preroll.len() > 15 {
                                preroll.pop_front();
                            }
                            while !vad.is_empty() {
                                vad.pop();
                            }
                            continue;
                        }
                        utterance = Some(preroll.drain(..).flatten().collect());
                        (heard, chimed) = (0, false);
                        if !self.paused.load(Ordering::SeqCst) {
                            voice.hush(); // they are talking: stop talking
                            event(json!({ "event": "speech" }));
                        }
                    }
                    utterance.as_mut().unwrap().extend_from_slice(&block);
                    if speaking {
                        heard += 1;
                        let chime = self.chimes && !self.paused.load(Ordering::SeqCst);
                        if heard == (0.3 * RATE as f32) as usize / BLOCK && chime {
                            chimed = true; // not for a cough: only once speech has gone on 0.3 s
                            speaker.chime(&chimes.start, CHIME_RATE);
                        }
                        continue;
                    }

                    // the detector closed the segment: real speech is queued, a noise was dropped
                    let real = !vad.is_empty();
                    while !vad.is_empty() {
                        vad.pop();
                    }
                    let audio = utterance.take().unwrap();
                    let text = if real { transcribe(&audio) } else { String::new() };
                    if chimed {
                        speaker.chime(&chimes.end, CHIME_RATE);
                    }
                    if text.chars().count() > 2 {
                        event(json!({ "event": "heard", "text": text }));
                    } else {
                        event(json!({ "event": "quiet" }));
                    }
                }
            }
            drop(microphone);
            event(json!({ "event": "deaf" }));
        }
    }
}
