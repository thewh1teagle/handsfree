//! The speaker: one output stream, kept open, that plays speech and chimes mixed together.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

#[derive(Default)]
struct Queues {
    speech: VecDeque<f32>,
    chime: VecDeque<f32>,
}

#[derive(Clone)]
pub struct Speaker {
    queues: Arc<Mutex<Queues>>,
    rate: u32,
}

/// Keeps the stream alive; it is not `Send`, so it stays on the thread that opened it.
pub struct SpeakerStream(#[allow(dead_code)] cpal::Stream);

impl Speaker {
    pub fn open() -> Result<(Speaker, SpeakerStream)> {
        let device = cpal::default_host().default_output_device().context("no output device")?;
        let config = device.default_output_config()?;
        let (rate, channels) = (config.sample_rate(), config.channels() as usize);
        let queues = Arc::new(Mutex::new(Queues::default()));
        let shared = queues.clone();
        let stream = device.build_output_stream(
            config.config(),
            move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let mut q = shared.lock().unwrap();
                for frame in out.chunks_mut(channels) {
                    let sample = q.speech.pop_front().unwrap_or(0.0) + q.chime.pop_front().unwrap_or(0.0);
                    frame.fill(sample.clamp(-1.0, 1.0));
                }
            },
            |error| eprintln!("handsfree: speaker: {error}"),
            None,
        )?;
        stream.play()?;
        Ok((Speaker { queues, rate }, SpeakerStream(stream)))
    }

    /// Queue speech recorded at `rate`.
    pub fn say(&self, samples: &[f32], rate: u32) {
        let resampled = resample(samples, rate, self.rate);
        self.queues.lock().unwrap().speech.extend(resampled);
    }

    /// Play a chime now, over whatever else is playing.
    pub fn chime(&self, samples: &[f32], rate: u32) {
        let resampled = resample(samples, rate, self.rate);
        let mut q = self.queues.lock().unwrap();
        q.chime.clear();
        q.chime.extend(resampled);
    }

    /// Drop speech that has not been played yet.
    pub fn hush(&self) {
        self.queues.lock().unwrap().speech.clear();
    }

    /// Seconds of speech still waiting to be played.
    pub fn pending(&self) -> f32 {
        self.queues.lock().unwrap().speech.len() as f32 / self.rate as f32
    }
}

/// Linear resampling: plenty for speech going to a speaker.
fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.is_empty() {
        return samples.to_vec();
    }
    let step = from as f64 / to as f64;
    let len = (samples.len() as f64 / step) as usize;
    (0..len)
        .map(|i| {
            let at = i as f64 * step;
            let (a, frac) = (at as usize, (at - at.floor()) as f32);
            let b = (a + 1).min(samples.len() - 1);
            samples[a] * (1.0 - frac) + samples[b] * frac
        })
        .collect()
}

/// The two earcons, at 48 kHz: a rising pair of notes when listening starts, the same pair
/// falling when it ends.
pub struct Chimes {
    pub start: Vec<f32>,
    pub end: Vec<f32>,
    /// A soft double pulse, repeated while an answer is being thought about.
    pub thinking: Vec<f32>,
}

pub const CHIME_RATE: u32 = 48_000;

impl Chimes {
    pub fn new(volume: f32) -> Chimes {
        let (low, high) = (587.33, 880.0); // D5 and A5, a fifth apart
        // lower and much quieter than the chimes: it is there to be half-noticed
        let thinking = pair(329.63, 392.0, volume * 0.4); // E4 and G4
        Chimes { start: pair(low, high, volume), end: pair(high, low, volume), thinking }
    }
}

fn note(freq: f32, seconds: f32) -> Vec<f32> {
    let tau = std::f32::consts::TAU;
    (0..(CHIME_RATE as f32 * seconds) as usize)
        .map(|i| {
            let t = i as f32 / CHIME_RATE as f32;
            // a soft bell: the fundamental, two quiet overtones that die faster, a 6 ms attack
            let tone = (tau * freq * t).sin() * (-t / 0.085).exp()
                + 0.22 * (tau * 2.0 * freq * t).sin() * (-t / 0.05).exp()
                + 0.06 * (tau * 3.0 * freq * t).sin() * (-t / 0.03).exp();
            tone * (t / 0.006).min(1.0)
        })
        .collect()
}

fn pair(first: f32, second: f32, volume: f32) -> Vec<f32> {
    let gap = (CHIME_RATE as f32 * 0.085) as usize; // the second note starts while the first rings
    let (a, b) = (note(first, 0.34), note(second, 0.34));
    let mut out = vec![0.0; gap + b.len()];
    for (i, s) in a.iter().enumerate() {
        out[i] += s;
    }
    for (i, s) in b.iter().enumerate() {
        out[gap + i] += s;
    }
    let fade = (CHIME_RATE as f32 * 0.02) as usize; // no click at the end
    let len = out.len();
    for i in 0..fade {
        out[len - fade + i] *= 1.0 - i as f32 / fade as f32;
    }
    let peak = out.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    out.iter().map(|s| s / peak * volume).collect()
}
