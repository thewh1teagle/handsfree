//! handsfree: voice for Claude Code. One background process owns the microphone and the
//! speaker; the other commands are small clients that talk to it.

mod ears;
mod mic;
mod models;
mod sound;
mod voice;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::time::Duration;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::{Value, json};

#[derive(Parser)]
#[command(version, about = "Hands-free voice for Claude Code: speak, listen, interrupt.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run in the background: keeps the voice loaded and owns the microphone and speaker.
    /// Prints one JSON event per line.
    Run {
        /// Speech model: a folder or hf://owner/name. Default: Phonon 31m (public).
        #[arg(long, env = "HANDSFREE_MODEL")]
        model: Option<String>,
        /// Voice, by name: one of the model's or of the Phonon voice catalog.
        #[arg(long, env = "HANDSFREE_VOICE")]
        voice: Option<String>,
        /// Start listening at once.
        #[arg(long)]
        listen: bool,
        /// Leave a running handsfree alone instead of taking over from it: report `busy` and exit.
        #[arg(long)]
        polite: bool,
        /// Seconds of quiet that end what you are saying. Default: 1.5.
        #[arg(long)]
        silence: Option<f32>,
        /// No sound when you start and finish speaking.
        #[arg(long)]
        no_chimes: bool,
    },
    /// Say something aloud (the text, or standard input). Ends when it has been said.
    Say {
        #[arg(long)]
        voice: Option<String>,
        text: Vec<String>,
    },
    /// List the voices you can ask for by name.
    Voices,
    /// Stop talking.
    Stop,
    /// Delete everything handsfree downloaded: the models, the voices, the settings, itself.
    Uninstall,
    /// Turn the microphone on or off.
    Listen {
        /// `pause` keeps hearing but stays out of the way (no chimes, speech not cut off); `resume` ends it.
        #[arg(value_parser = ["on", "off", "pause", "resume"])]
        state: String,
    },
}

/// The voice used when none is chosen: from the Phonon catalog, fetched on first use. If it
/// cannot be fetched, the model's own voice is used.
const DEFAULT_VOICE: &str = "Harper";

/// How long a client waits for a process that was only just started.
const WAIT: Duration = Duration::from_secs(5);

/// One event for whoever started us, as a line of JSON on standard output.
pub fn event(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn port_file() -> std::path::PathBuf {
    models::home().join("port")
}

/// Send one request to the running process and wait for it to finish. With `patience`, a
/// process that is still starting is waited for.
fn ask(request: Value, patience: Duration) -> Result<()> {
    let started = std::time::Instant::now();
    let mut stream = loop {
        let port = std::fs::read_to_string(port_file()).ok().and_then(|text| text.trim().parse::<u16>().ok());
        if let Some(Ok(stream)) = port.map(|port| TcpStream::connect((Ipv4Addr::LOCALHOST, port))) {
            break stream;
        }
        if started.elapsed() >= patience {
            anyhow::bail!("handsfree is not running (start it with `handsfree run`)");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    writeln!(stream, "{request}")?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply)?; // closes when done, or when cut off
    Ok(())
}

/// Remove everything this program downloaded: its own folder (the binary, the recognition
/// models, the settings) and the Phonon models and voices in the Hugging Face cache.
fn uninstall() -> Result<()> {
    let _ = ask(json!({ "quit": true }), Duration::ZERO);
    let mut removed = Vec::new();
    let home = models::home();
    if home.exists() {
        std::fs::remove_dir_all(&home)?;
        removed.push(home);
    }
    let user = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default();
    let hub = std::env::var_os("HF_HOME")
        .map(|dir| std::path::PathBuf::from(dir).join("hub"))
        .unwrap_or_else(|| std::path::PathBuf::from(user).join(".cache").join("huggingface").join("hub"));
    for entry in std::fs::read_dir(&hub).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with("models--gradium--phonon") {
            std::fs::remove_dir_all(entry.path())?;
            removed.push(entry.path());
        }
    }
    for path in &removed {
        println!("removed {}", path.display());
    }
    if removed.is_empty() {
        println!("nothing to remove");
    }
    Ok(())
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Say { voice, text } => {
            let mut text = text.join(" ");
            if text.trim().is_empty() {
                std::io::stdin().read_to_string(&mut text)?;
            }
            if text.trim().is_empty() {
                return Ok(());
            }
            ask(json!({ "say": text.trim(), "voice": voice }), WAIT)
        }
        Command::Voices => {
            let catalog = ptts::voice_catalog::VoiceCatalog::new(ptts::voice_catalog::DEFAULT_VOICE_CATALOG)?;
            for voice in catalog.voices()?.iter().filter(|v| v.language.as_deref() == Some("en")) {
                println!("{}: {}", voice.name, voice.description.as_deref().unwrap_or(""));
            }
            Ok(())
        }
        Command::Stop => ask(json!({ "stop": true }), Duration::ZERO),
        Command::Uninstall => uninstall(),
        Command::Listen { state } => match state.as_str() {
            "pause" => ask(json!({ "paused": true }), WAIT),
            "resume" => ask(json!({ "paused": false }), WAIT),
            _ => ask(json!({ "listen": state == "on" }), WAIT),
        },
        Command::Run { model, voice, listen, polite, silence, no_chimes } => {
            // flags, then ~/.cache/handsfree/config.json, then the defaults
            let config: Value = std::fs::read_to_string(models::home().join("config.json"))
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or(Value::Null);
            let text = |key: &str| config[key].as_str().map(str::to_string);
            if polite && ask(json!({ "ping": true }), Duration::ZERO).is_ok() {
                event(json!({ "event": "busy" })); // another session has the voice: do not take it
                return Ok(());
            }
            run(
                model.or(text("model")).unwrap_or_else(|| ptts::checkpoint::DEFAULT_MODEL.to_string()),
                Some(voice.or(text("voice")).unwrap_or_else(|| DEFAULT_VOICE.to_string())),
                listen,
                silence.or(config["silence"].as_f64().map(|v| v as f32)).unwrap_or(1.5),
                !no_chimes && config["chimes"].as_bool() != Some(false),
            )
        }
    }
}

fn run(model: String, default_voice: Option<String>, listen: bool, silence: f32, chimes: bool) -> Result<()> {
    // One at a time: a newer one takes over the microphone and the speaker from an older one.
    if ask(json!({ "quit": true }), Duration::ZERO).is_ok() {
        std::thread::sleep(Duration::from_millis(300));
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    std::fs::create_dir_all(models::home())?;
    std::fs::write(port_file(), listener.local_addr()?.port().to_string())?;

    let (speaker, _stream) = sound::Speaker::open()?;
    let (ready, loaded) = channel();
    let voice = voice::Voice::start(model, default_voice, speaker.clone(), ready);

    let listening = Arc::new(AtomicBool::new(listen));
    let paused = Arc::new(AtomicBool::new(false));
    let ears = ears::Ears { on: listening.clone(), paused: paused.clone(), silence, chimes };
    let (ears_voice, ears_speaker) = (voice.clone(), speaker.clone());
    std::thread::spawn(move || {
        if let Err(error) = ears.run(ears_voice, ears_speaker) {
            event(json!({ "event": "error", "what": "listening", "message": format!("{error:#}") }));
        }
    });
    std::thread::spawn(move || match loaded.recv() {
        Ok(Ok(())) => event(json!({ "event": "ready" })),
        Ok(Err(error)) => event(json!({ "event": "error", "what": "speech", "message": format!("{error:#}") })),
        Err(_) => {}
    });

    for connection in listener.incoming() {
        let Ok(connection) = connection else { continue };
        let (voice, listening, paused) = (voice.clone(), listening.clone(), paused.clone());
        std::thread::spawn(move || {
            let _ = serve(connection, voice, listening, paused);
        });
    }
    Ok(())
}

fn serve(
    mut connection: TcpStream,
    voice: voice::Voice,
    listening: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
) -> Result<()> {
    let mut line = String::new();
    BufReader::new(connection.try_clone()?).read_line(&mut line)?;
    let request: Value = serde_json::from_str(&line)?;

    if request["quit"].as_bool() == Some(true) {
        event(json!({ "event": "taken" })); // another session started its own
        let _ = connection.write_all(b"ok\n");
        std::process::exit(0);
    } else if let Some(on) = request["listen"].as_bool() {
        listening.store(on, Ordering::SeqCst);
        paused.store(false, Ordering::SeqCst);
    } else if let Some(on) = request["paused"].as_bool() {
        paused.store(on, Ordering::SeqCst);
    } else if request["stop"].as_bool() == Some(true) {
        voice.hush();
    } else if let Some(text) = request["say"].as_str() {
        let (done, finished) = channel();
        let wanted = Arc::new(AtomicBool::new(true));
        voice.say(voice::Request {
            text: text.to_string(),
            voice: request["voice"].as_str().map(str::to_string),
            done,
            wanted: wanted.clone(),
        });
        // wait until it has been said; if whoever asked goes away (was killed), stop talking
        connection.set_nonblocking(true)?;
        loop {
            match finished.recv_timeout(Duration::from_millis(50)) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {
                    if matches!(connection.peek(&mut [0u8; 1]), Ok(0)) {
                        wanted.store(false, Ordering::SeqCst);
                    }
                }
            }
        }
        connection.set_nonblocking(false)?;
    }
    let _ = connection.write_all(b"ok\n");
    Ok(())
}
