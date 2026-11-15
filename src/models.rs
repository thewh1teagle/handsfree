//! Model files, downloaded once into the cache directory.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::event;

const VAD: (&str, &str) = (
    "silero_vad.onnx",
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
);
const ASR_REPO: &str =
    "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/main";
const ASR_FILES: [&str; 4] = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];

/// `~/.cache/handsfree` (or `HANDSFREE_HOME`): models, and the running daemon's port.
pub fn home() -> PathBuf {
    if let Some(dir) = std::env::var_os("HANDSFREE_HOME") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default();
    PathBuf::from(base).join(".cache").join("handsfree")
}

fn fetch(name: &str, url: &str) -> Result<PathBuf> {
    let path = home().join("models").join(name);
    if path.exists() {
        return Ok(path);
    }
    fs::create_dir_all(path.parent().unwrap())?;
    let response = ureq::get(url).call().with_context(|| format!("downloading {name}"))?;
    let total: u64 = response.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let part = path.with_extension("part");
    let mut file = fs::File::create(&part)?;
    let mut reader = response.into_reader();
    let (mut buffer, mut done, mut shown) = (vec![0u8; 1 << 16], 0u64, u64::MAX);
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n])?;
        done += n as u64;
        let percent = if total > 0 { done * 100 / total } else { 0 };
        if percent != shown {
            shown = percent;
            event(serde_json::json!({ "event": "download", "file": name, "percent": percent }));
        }
    }
    fs::rename(&part, &path)?;
    Ok(path)
}

pub fn vad() -> Result<PathBuf> {
    fetch(VAD.0, VAD.1)
}

/// The recognizer's folder: encoder, decoder, joiner and tokens.
pub fn recognizer() -> Result<PathBuf> {
    for name in ASR_FILES {
        fetch(&format!("parakeet-en/{name}"), &format!("{ASR_REPO}/{name}"))?;
    }
    Ok(home().join("models").join("parakeet-en"))
}
