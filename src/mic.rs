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
    Ok(Mic { rate, echo_cancelled: false, _keep: Box::new(stream) })
}
