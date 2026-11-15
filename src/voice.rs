//! Speech: Phonon, loaded once and kept warm, playing as it generates.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;
use ptts::checkpoint::{Checkpoint, ResolveOptions};
use ptts::preprocess::Lang;
use ptts::synth::{Quant, SpeechOptions};
use ptts::voice_catalog::{DEFAULT_VOICE_CATALOG, VoiceCatalog};

use crate::sound::Speaker;

pub struct Request {
    pub text: String,
    pub voice: Option<String>,
    /// Told when the words have been said, or cut off.
    pub done: Sender<()>,
    /// False once whoever asked has gone away: stop talking.
    pub wanted: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct Voice {
    requests: Sender<Request>,
    /// Each request and each `hush` takes the next number; speech of an older number stops.
    turn: Arc<AtomicU64>,
    pub speaking: Arc<AtomicBool>,
    speaker: Speaker,
}

impl Voice {
    /// Loads the model on its own thread; `ready` is told once it can speak.
    pub fn start(model: String, voice: Option<String>, speaker: Speaker, ready: Sender<Result<()>>) -> Voice {
        let (requests, inbox) = channel();
        let turn = Arc::new(AtomicU64::new(0));
        let speaking = Arc::new(AtomicBool::new(false));
        let me = Voice { requests, turn, speaking, speaker };
        let worker = me.clone();
        thread::spawn(move || worker.run(model, voice, inbox, ready));
        me
    }

    pub fn say(&self, request: Request) {
        self.turn.fetch_add(1, Ordering::SeqCst);
        self.speaker.hush();
        let _ = self.requests.send(request);
    }

    /// Stop talking, now.
    pub fn hush(&self) {
        self.turn.fetch_add(1, Ordering::SeqCst);
        self.speaker.hush();
    }

    fn run(self, model: String, default_voice: Option<String>, inbox: Receiver<Request>, ready: Sender<Result<()>>) {
        let loaded = (|| -> Result<_> {
            let checkpoint = Checkpoint::locate(&model, ResolveOptions { quant: Quant::default(), weights: None })?;
            let mut tts = checkpoint.builder(Lang::En).build()?;
            checkpoint.register_voices(&mut tts);
            Ok(tts)
        })();
        let mut tts = match loaded {
            Ok(tts) => {
                let _ = ready.send(Ok(()));
                tts
            }
            Err(error) => {
                let _ = ready.send(Err(error));
                return;
            }
        };
        let catalog = VoiceCatalog::new(DEFAULT_VOICE_CATALOG).ok();

        for request in inbox {
            let mine = self.turn.load(Ordering::SeqCst);
            let current = || self.turn.load(Ordering::SeqCst) == mine && request.wanted.load(Ordering::SeqCst);
            let mut options = SpeechOptions::default();
            if let Some(name) = request.voice.as_ref().or(default_voice.as_ref()) {
                // a voice the model lacks is fetched from the catalog the first time it is asked for
                let known = catalog.as_ref().and_then(|c| c.register(&mut tts, name).ok());
                if let Some(name) = known.filter(|n| tts.voices().contains(n)) {
                    options = options.voice(name);
                }
            }
            self.speaking.store(true, Ordering::SeqCst);
            match tts.stream_with(&request.text, &options) {
                Ok(stream) => {
                    let rate = stream.sample_rate();
                    for chunk in stream {
                        if !current() {
                            break;
                        }
                        match chunk {
                            Ok(pcm) => self.speaker.say(&pcm, rate),
                            Err(error) => {
                                eprintln!("handsfree: speech: {error}");
                                break;
                            }
                        }
                        // stay a little ahead of the speaker, not minutes ahead
                        while current() && self.speaker.pending() > 1.0 {
                            thread::sleep(Duration::from_millis(20));
                        }
                    }
                }
                Err(error) => eprintln!("handsfree: speech: {error}"),
            }
            // let what is queued play out, unless told to stop
            let started = Instant::now();
            while current() && self.speaker.pending() > 0.0 && started.elapsed() < Duration::from_secs(120) {
                thread::sleep(Duration::from_millis(20));
            }
            if !current() {
                self.speaker.hush();
            }
            if self.turn.load(Ordering::SeqCst) == mine {
                self.speaking.store(false, Ordering::SeqCst);
            }
            let _ = request.done.send(());
        }
    }
}
