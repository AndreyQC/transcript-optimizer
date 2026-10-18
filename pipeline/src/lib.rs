//! Пайплайн транскрибации: decode → ASR (transcribe-rs) → диаризация
//! (polyvoice) → сшивка спикеров по таймкодам.
//!
//! Библиотечная часть — чистые функции с колбэками прогресса; stdio-JSON
//! протокол сидит в `main.rs`. Логика перенесена из спайка 20261018_002.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Serialize;

pub const TARGET_RATE: usize = 16000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    Parakeet,
    GigaAm,
}

/// Вариант кластеризатора диаризации.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClustererOpt {
    Vbx,
    Ahc { threshold: f32 },
}

#[derive(Debug)]
pub struct DecodeResult {
    pub samples: Vec<f32>,
    pub format: &'static str,
    pub channels: usize,
    pub source_rate: u32,
    pub audio_secs: f64,
    pub decode_secs: f64,
    pub limited: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AsrSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct AsrOutput {
    pub text: String,
    pub segments: Vec<AsrSegment>,
    pub model: String,
    pub asr_secs: f64,
    pub load_secs: f64,
    pub chunk_secs: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeakerTurnRec {
    pub speaker: usize,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Serialize)]
pub struct DiarizationOutput {
    pub turns: Vec<SpeakerTurnRec>,
    pub speakers: usize,
    pub diar_secs: f64,
    pub build_secs: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MergedBlock {
    pub speaker: usize,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

// ---- decode ---------------------------------------------------------------

pub fn decode_audio(path: &Path, limit_secs: Option<usize>) -> Result<DecodeResult> {
    let t = std::time::Instant::now();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let (interleaved, rate, channels, fmt) = if ext == "wav" {
        decode_wav(path)?
    } else {
        decode_symphonia(path)?
    };

    let mono = mixdown(interleaved, channels);
    let mut mono = resample_to_16k(mono, rate as usize)?;
    let mut limited = false;
    if let Some(lim) = limit_secs {
        let max = lim * TARGET_RATE;
        if mono.len() > max {
            mono.truncate(max);
            limited = true;
        }
    }
    let decode_secs = t.elapsed().as_secs_f64();
    let audio_secs = mono.len() as f64 / TARGET_RATE as f64;
    Ok(DecodeResult {
        samples: mono,
        format: fmt,
        channels,
        source_rate: rate,
        audio_secs,
        decode_secs,
        limited,
    })
}

fn decode_wav(path: &Path) -> Result<(Vec<f32>, u32, usize, &'static str)> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let rate = spec.sample_rate;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<_, _>>()?,
        hound::SampleFormat::Int => reader
            .samples::<i32>()
            .map(|s| {
                s.map(|v| {
                    let norm = v as f64 / (1i64 << (spec.bits_per_sample - 1)) as f64;
                    norm as f32
                })
            })
            .collect::<std::result::Result<_, _>>()?,
    };
    Ok((samples, rate, channels, "wav"))
}

fn decode_symphonia(path: &Path) -> Result<(Vec<f32>, u32, usize, &'static str)> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL, CODEC_TYPE_OPUS};
    use symphonia::core::errors::Error as SymError;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe().format(
        &hint,
        mss,
        &Default::default(),
        &MetadataOptions::default(),
    )?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .context("no audio track")?
        .clone();
    let track_id = track.id;
    let sym_rate = track.codec_params.sample_rate;
    let sym_channels = track.codec_params.channels.map(|c| c.count());

    // symphonia умеет демуксить mkv/webm, но не декодировать Opus: пакеты
    // отдаём в libopus, OpusHead (CodecPrivate) даёт pre-skip и каналы.
    if track.codec_params.codec == CODEC_TYPE_OPUS {
        let extra = track
            .codec_params
            .extra_data
            .as_deref()
            .context("opus track without OpusHead (CodecPrivate)")?;
        anyhow::ensure!(
            extra.len() >= 12 && &extra[..8] == b"OpusHead",
            "malformed OpusHead"
        );
        let opus_channels = extra[9] as usize;
        let preskip = u16::from_le_bytes([extra[10], extra[11]]) as usize;

        let channels_kind = match opus_channels {
            1 => audiopus::Channels::Mono,
            2 => audiopus::Channels::Stereo,
            n => bail!("unsupported opus channel count: {n}"),
        };
        let mut opus_dec =
            audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, channels_kind)
                .context("libopus decoder init")?;

        let max_frame = 5760usize; // 120 ms @ 48 kHz
        let mut frame_buf = vec![0f32; max_frame * opus_channels];
        let mut interleaved: Vec<f32> = Vec::new();
        loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break
                }
                Err(SymError::ResetRequired) => bail!("stream reset required (unsupported)"),
                Err(e) => return Err(e.into()),
            };
            if packet.track_id() != track_id {
                continue;
            }
            let decoded = match opus_dec.decode_float(Some(packet.buf()), &mut frame_buf, false) {
                Ok(n) => n,
                Err(_) => continue, // битый пакет — пропускаем
            };
            interleaved.extend_from_slice(&frame_buf[..decoded * opus_channels]);
        }
        let skip = (preskip * opus_channels).min(interleaved.len());
        interleaved.drain(..skip);
        let fmt: &'static str = match ext.as_str() {
            "webm" | "mkv" => "webm/opus",
            _ => "ogg/opus",
        };
        return Ok((interleaved, 48000, opus_channels, fmt));
    }

    let rate = sym_rate.context("no sample rate")?;
    let channels = sym_channels.unwrap_or(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| {
            anyhow::anyhow!(
                "symphonia cannot decode codec {:?}: {e}",
                track.codec_params.codec
            )
        })?;

    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut last_spec = None;
    let mut interleaved: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymError::ResetRequired) => bail!("stream reset required (unsupported)"),
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        };
        let spec = *decoded.spec();
        if last_spec.as_ref() != Some(&spec) {
            sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
            last_spec = Some(spec);
        }
        let sb = sample_buf.as_mut().unwrap();
        sb.copy_interleaved_ref(decoded);
        interleaved.extend_from_slice(sb.samples());
    }

    let fmt: &'static str = match ext.as_str() {
        "webm" | "mkv" => "webm/mkv",
        "ogg" | "oga" | "opus" => "ogg",
        "mp4" | "m4a" => "mp4",
        "mp3" => "mp3",
        "flac" => "flac",
        _ => "symphonia",
    };
    Ok((interleaved, rate, channels, fmt))
}

fn mixdown(interleaved: Vec<f32>, channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved;
    }
    interleaved
        .chunks(channels)
        .map(|c| c.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn resample_to_16k(mono: Vec<f32>, in_rate: usize) -> Result<Vec<f32>> {
    use rubato::{FftFixedIn, Resampler};

    if in_rate == TARGET_RATE {
        return Ok(mono);
    }
    let chunk = 4096usize;
    let mut resampler = FftFixedIn::<f32>::new(in_rate, TARGET_RATE, chunk, 2, 1)?;
    let expected_total = mono.len() * TARGET_RATE / in_rate;

    let mut out: Vec<f32> = Vec::with_capacity(expected_total + chunk * 4);
    let mut pos = 0usize;
    while pos < mono.len() {
        let end = (pos + chunk).min(mono.len());
        let mut block = vec![mono[pos..end].to_vec()];
        if block[0].len() < chunk {
            block[0].resize(chunk, 0.0);
        }
        let mut block_out = vec![vec![0f32; resampler.output_frames_max()]];
        resampler.process_into_buffer(&block, &mut block_out, None)?;
        out.extend_from_slice(&block_out[0]);
        pos = end;
    }
    out.truncate(expected_total);
    Ok(out)
}

// ---- ASR ------------------------------------------------------------------

/// `progress(idx, total, chunk_secs)` вызывается после каждого чанка.
pub fn run_asr(
    samples: &[f32],
    engine: EngineKind,
    model_dir: &Path,
    chunk_secs: usize,
    progress: &mut dyn FnMut(usize, usize, f64),
) -> Result<AsrOutput> {
    let t_all = std::time::Instant::now();
    let chunk_samples = chunk_secs * TARGET_RATE;
    let total = samples.len().max(1);
    let nchunks = total.div_ceil(chunk_samples);
    let ranges = chunk_ranges(total, chunk_samples);

    let (text, segments, model, load_secs) = match engine {
        EngineKind::Parakeet => {
            use transcribe_rs::onnx::parakeet::{
                ParakeetModel, ParakeetParams, TimestampGranularity,
            };
            use transcribe_rs::onnx::Quantization;

            let mut model = ParakeetModel::load(model_dir, &Quantization::Int8)
                .context("parakeet model load")?;
            let load_secs = t_all.elapsed().as_secs_f64();

            let params = ParakeetParams {
                language: Some("ru".into()),
                timestamp_granularity: Some(TimestampGranularity::Segment),
            };
            let mut text = String::new();
            let mut segments: Vec<AsrSegment> = Vec::new();
            for (idx, (start, end)) in ranges.into_iter().enumerate() {
                let tc = std::time::Instant::now();
                let mut res = model
                    .transcribe_with(&samples[start..end], &params)
                    .with_context(|| format!("parakeet chunk {}/{}", idx + 1, nchunks))?;
                res.offset_timestamps(start as f32 / TARGET_RATE as f32);
                if let Some(segs) = res.segments.take() {
                    segments.extend(segs.into_iter().map(|s| AsrSegment {
                        start: s.start,
                        end: s.end,
                        text: s.text,
                    }));
                }
                text.push_str(res.text.trim_end());
                text.push(' ');
                progress(idx + 1, nchunks, tc.elapsed().as_secs_f64());
            }
            (text, segments, "parakeet-tdt-0.6b-v3-int8".to_string(), load_secs)
        }
        EngineKind::GigaAm => {
            use transcribe_rs::onnx::gigaam::GigaAMModel;
            use transcribe_rs::onnx::Quantization;

            let mut model = GigaAMModel::load(model_dir, &Quantization::Int8)
                .context("gigaam model load")?;
            let load_secs = t_all.elapsed().as_secs_f64();

            let params = Default::default();
            let mut text = String::new();
            for (idx, (start, end)) in ranges.into_iter().enumerate() {
                let tc = std::time::Instant::now();
                let res = model
                    .transcribe_with(&samples[start..end], &params)
                    .with_context(|| format!("gigaam chunk {}/{}", idx + 1, nchunks))?;
                text.push_str(res.text.trim_end());
                text.push(' ');
                progress(idx + 1, nchunks, tc.elapsed().as_secs_f64());
            }
            // CTC-модель без таймкодов: только текст, без сшивки спикеров.
            (text, Vec::new(), "gigaam-v3-e2e-ctc-int8".to_string(), load_secs)
        }
    };

    Ok(AsrOutput {
        asr_secs: t_all.elapsed().as_secs_f64() - load_secs,
        load_secs,
        text,
        segments,
        model,
        chunk_secs,
    })
}

// ---- diarization ----------------------------------------------------------

pub fn run_diarization(
    samples: &[f32],
    clusterer: &ClustererOpt,
    embed_window_secs: Option<f32>,
    max_speakers: Option<u8>,
) -> Result<DiarizationOutput> {
    let t = std::time::Instant::now();
    let registry = polyvoice::models::ModelRegistry::default()
        .context("polyvoice model registry (нет моделей в %LOCALAPPDATA%\\polyvoice\\models)")?;
    let mut config = polyvoice::PipelineConfig::default();
    config.profile = polyvoice::types::Profile::Balanced;
    config.clusterer = match clusterer {
        ClustererOpt::Vbx => polyvoice::ClustererKind::Vbx,
        ClustererOpt::Ahc { threshold } => polyvoice::ClustererKind::Ahc {
            threshold: *threshold,
        },
    };
    if let Some(w) = embed_window_secs {
        config.embed_window_secs = Some(w);
    }
    if let Some(m) = max_speakers {
        config.max_speakers = m;
    }
    let pipeline = polyvoice::Pipeline::builder()
        .config(config)
        .with_models_from(registry)
        .build()
        .context("polyvoice pipeline build")?;
    let build_secs = t.elapsed().as_secs_f64();

    let t = std::time::Instant::now();
    let sr = polyvoice::types::SampleRate::new(TARGET_RATE as u32)
        .ok_or_else(|| anyhow::anyhow!("bad sample rate"))?;
    let dia = pipeline.run(samples, sr).context("polyvoice run")?;
    let diar_secs = t.elapsed().as_secs_f64();

    let turns: Vec<SpeakerTurnRec> = dia
        .turns
        .iter()
        .map(|turn| SpeakerTurnRec {
            speaker: turn.speaker.0 as usize,
            start: turn.time.start as f64,
            end: turn.time.end as f64,
        })
        .collect();
    let speakers = turns.iter().map(|t| t.speaker).collect::<std::collections::BTreeSet<_>>().len();
    Ok(DiarizationOutput {
        turns,
        speakers,
        diar_secs,
        build_secs,
    })
}

// ---- merge ----------------------------------------------------------------

pub fn merge_segments_with_turns(
    segments: &[AsrSegment],
    turns: &[SpeakerTurnRec],
) -> Vec<MergedBlock> {
    let mut blocks: Vec<MergedBlock> = Vec::new();
    for seg in segments {
        let (s, e) = (seg.start as f64, seg.end as f64);
        let mut best: Option<(usize, f64)> = None; // (speaker, overlap)
        for t in turns {
            let ov = e.min(t.end) - s.max(t.start);
            if ov > 0.0 && best.map(|(_, b)| ov > b).unwrap_or(true) {
                best = Some((t.speaker, ov));
            }
        }
        let speaker = match best {
            Some((spk, _)) => spk,
            None => turns
                .iter()
                .min_by(|a, b| {
                    let da = (a.start - e).abs().min((a.end - s).abs());
                    let db = (b.start - e).abs().min((b.end - s).abs());
                    da.partial_cmp(&db).unwrap()
                })
                .map(|t| t.speaker)
                .unwrap_or(0),
        };
        let text = seg.text.trim();
        if text.is_empty() {
            continue;
        }
        match blocks.last_mut() {
            Some(b) if b.speaker == speaker => {
                b.end = e;
                b.text.push(' ');
                b.text.push_str(text);
            }
            _ => blocks.push(MergedBlock {
                speaker,
                start: s,
                end: e,
                text: text.to_string(),
            }),
        }
    }
    blocks
}

pub fn fmt_hms(secs: f64) -> String {
    let total = secs.max(0.0) as u64;
    format!(
        "{:02}:{:02}:{:02}",
        total / 3600,
        (total % 3600) / 60,
        total % 60
    )
}

fn chunk_ranges(total: usize, chunk: usize) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    while start < total {
        let end = (start + chunk).min(total);
        ranges.push((start, end));
        start = end;
    }
    ranges
}

// ---- tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f32, end: f32, text: &str) -> AsrSegment {
        AsrSegment {
            start,
            end,
            text: text.into(),
        }
    }

    fn turn(speaker: usize, start: f64, end: f64) -> SpeakerTurnRec {
        SpeakerTurnRec { speaker, start, end }
    }

    #[test]
    fn merge_assigns_speaker_by_max_overlap() {
        let segments = vec![seg(0.0, 5.0, "aaa"), seg(5.0, 10.0, "bbb")];
        let turns = vec![turn(0, 0.0, 4.0), turn(1, 4.0, 12.0)];
        let blocks = merge_segments_with_turns(&segments, &turns);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].speaker, 0); // 4с пересечения с 0 vs 1с с 1
        assert_eq!(blocks[1].speaker, 1);
    }

    #[test]
    fn merge_coalesces_consecutive_same_speaker() {
        let segments = vec![seg(0.0, 2.0, "aaa"), seg(2.0, 4.0, "bbb"), seg(4.0, 6.0, "ccc")];
        let turns = vec![turn(7, 0.0, 10.0)];
        let blocks = merge_segments_with_turns(&segments, &turns);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "aaa bbb ccc");
    }

    #[test]
    fn merge_no_overlap_takes_nearest_turn() {
        let segments = vec![seg(0.0, 1.0, "один")];
        let turns = vec![turn(0, 5.0, 6.0), turn(1, 3.0, 3.5)];
        let blocks = merge_segments_with_turns(&segments, &turns);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].speaker, 1); // ближе к [3.0;3.5]
    }

    #[test]
    fn merge_skips_empty_segments() {
        let segments = vec![seg(0.0, 1.0, "   "), seg(1.0, 2.0, "текст")];
        let turns = vec![turn(0, 0.0, 5.0)];
        let blocks = merge_segments_with_turns(&segments, &turns);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "текст");
    }

    #[test]
    fn decode_wav_roundtrip() {
        // Генерируем wav 8 кГц mono и проверяем декод+ресемплинг в 16 кГц.
        let dir = std::env::temp_dir().join("pipeline_test_decode");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t8k.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 8000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for i in 0..8000 {
            let v = (i as f32 / 8000.0 * 2.0 * std::f32::consts::PI).sin() * 8000.0;
            w.write_sample(v as i16).unwrap();
        }
        w.finalize().unwrap();

        let res = decode_audio(&path, None).unwrap();
        assert_eq!(res.format, "wav");
        assert_eq!(res.channels, 1);
        // 1с @ 8кГц -> 1с @ 16кГц
        assert!((res.audio_secs - 1.0).abs() < 0.05, "got {}", res.audio_secs);
        assert!(!res.samples.is_empty());
    }

    #[test]
    fn decode_respects_limit() {
        let dir = std::env::temp_dir().join("pipeline_test_decode");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t16k.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for i in 0..16000 * 10 {
            let v = (i as f32 * 0.01).sin() * 100.0;
            w.write_sample(v as i16).unwrap();
        }
        w.finalize().unwrap();

        let res = decode_audio(&path, Some(2)).unwrap();
        assert!(res.limited);
        assert!((res.audio_secs - 2.0).abs() < 0.01, "got {}", res.audio_secs);
    }

    #[test]
    fn hms_format() {
        assert_eq!(fmt_hms(0.0), "00:00:00");
        assert_eq!(fmt_hms(83.7), "00:01:23");
        assert_eq!(fmt_hms(3661.0), "01:01:01");
    }
}
