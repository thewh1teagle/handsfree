//! The microphone. On macOS it goes through the system's voice processing, which removes
//! whatever the computer itself is playing, our own voice included, so we can listen while
//! we talk. Elsewhere it is a plain input stream, and the ears go deaf while we speak.

use std::sync::mpsc::Sender;

use anyhow::Result;

/// A running microphone: mono samples at `rate` arrive on the sender it was opened with.
/// Dropping it releases the device.
pub struct Mic {
    pub rate: u32,
    pub echo_cancelled: bool,
    _keep: Box<dyn std::any::Any>,
}

#[cfg(target_os = "macos")]
pub fn open(samples: Sender<Vec<f32>>) -> Result<Mic> {
    use std::ptr::NonNull;

    use anyhow::anyhow;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_avf_audio::{
        AVAudioEngine, AVAudioPCMBuffer, AVAudioTime, AVAudioVoiceProcessingOtherAudioDuckingConfiguration,
        AVAudioVoiceProcessingOtherAudioDuckingLevel,
    };

    struct Running(objc2::rc::Retained<AVAudioEngine>);
    impl Drop for Running {
        fn drop(&mut self) {
            unsafe {
                self.0.inputNode().removeTapOnBus(0);
                self.0.stop();
            }
        }
    }

    unsafe {
        let engine = AVAudioEngine::new();
        let input = engine.inputNode();
        input
            .setVoiceProcessingEnabled_error(true)
            .map_err(|e| anyhow!("voice processing unavailable: {e:?}"))?;
        // do not turn down what is playing, our own speech included
        input.setVoiceProcessingOtherAudioDuckingConfiguration(AVAudioVoiceProcessingOtherAudioDuckingConfiguration {
            enableAdvancedDucking: Bool::NO,
            duckingLevel: AVAudioVoiceProcessingOtherAudioDuckingLevel::Min,
        });
        let format = input.outputFormatForBus(0);
        let rate = format.sampleRate() as u32;
        let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
            let buffer = buffer.as_ref();
            let channels = buffer.floatChannelData();
            if channels.is_null() {
                return;
            }
            // the first channel is the processed voice
            let data = std::slice::from_raw_parts((*channels).as_ptr(), buffer.frameLength() as usize);
            let _ = samples.send(data.to_vec());
        });
        input.installTapOnBus_bufferSize_format_block(0, 4800, Some(&format), RcBlock::as_ptr(&tap));
        engine.prepare();
        engine.startAndReturnError().map_err(|e| anyhow!("microphone did not start: {e:?}"))?;
        Ok(Mic { rate, echo_cancelled: true, _keep: Box::new((Running(engine), tap)) })
    }
}

/// Linux, opt-in and untested by its authors: asks the audio server (PipeWire or PulseAudio)
/// to load its echo-cancel module and routes this process's microphone and speaker through
/// the virtual devices it creates. Any failure leaves the plain microphone in use.
#[cfg(target_os = "linux")]
pub struct EchoCancel(String);

#[cfg(target_os = "linux")]
impl EchoCancel {
    const SOURCE: &'static str = "handsfree_mic";
    const SINK: &'static str = "handsfree_speaker";

    /// Call before any audio device is opened.
    pub fn load() -> Option<EchoCancel> {
        use std::process::Command;
        // a module left behind by a run that was killed
        if let Ok(listed) = Command::new("pactl").args(["list", "short", "modules"]).output() {
            for line in String::from_utf8_lossy(&listed.stdout).lines().filter(|l| l.contains(Self::SOURCE)) {
                if let Some(id) = line.split_whitespace().next() {
                    let _ = Command::new("pactl").args(["unload-module", id]).status();
                }
            }
        }
        let loaded = Command::new("pactl")
            .args([
                "load-module",
                "module-echo-cancel",
                "aec_method=webrtc",
                &format!("source_name={}", Self::SOURCE),
                &format!("sink_name={}", Self::SINK),
            ])
            .output()
            .ok()?;
        if !loaded.status.success() {
            return None;
        }
        // SAFETY: called at startup, before any other thread exists.
        unsafe {
            std::env::set_var("PULSE_SOURCE", Self::SOURCE);
            std::env::set_var("PULSE_SINK", Self::SINK);
        }
        Some(EchoCancel(String::from_utf8_lossy(&loaded.stdout).trim().to_string()))
    }
}

#[cfg(target_os = "linux")]
impl Drop for EchoCancel {
    fn drop(&mut self) {
        let _ = std::process::Command::new("pactl").args(["unload-module", &self.0]).status();
    }
}

/// Set once the system's echo cancellation has been put in front of the plain microphone.
#[cfg(not(target_os = "macos"))]
pub static ECHO_CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(not(target_os = "macos"))]
pub fn open(samples: Sender<Vec<f32>>) -> Result<Mic> {
    use anyhow::Context;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let device = cpal::default_host().default_input_device().context("no microphone")?;
    let config = device.default_input_config()?;
    let (rate, channels) = (config.sample_rate(), config.channels() as usize);
    let stream = device.build_input_stream(
        config.config(),
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            let mono = data.chunks(channels).map(|frame| frame.iter().sum::<f32>() / channels as f32).collect();
            let _ = samples.send(mono);
        },
        |error| eprintln!("handsfree: microphone: {error}"),
        None,
    )?;
    stream.play()?;
    let echo_cancelled = ECHO_CANCELLED.load(std::sync::atomic::Ordering::SeqCst);
    Ok(Mic { rate, echo_cancelled, _keep: Box::new(stream) })
}
