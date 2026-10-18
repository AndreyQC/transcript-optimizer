//! Спайк 20261018_002: decode -> ASR (transcribe-rs) -> diarization (polyvoice) -> merge.
//!
//! Одноразовый код: anyhow + eprintln, пути и опции — аргументами CLI.
//!
//! usage:
//!   spike-transcriber <input.(wav|webm|mp3|...)> <model_dir> [--limit SECS] [--engine parakeet|gigaam]
//!
//! Выход рядом со входом: transcript.txt + metrics.json.

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity};
use transcribe_rs::onnx::gigaam::GigaAMModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::{TranscriptionResult, TranscriptionSegment};

const TARGET_RATE: usize = 16000;
const CHUNK_SECS: usize = 120;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(input) = args.next() else {
        bail!("usage: spike-transcriber <input> <model_dir> [--limit SECS] [--engine parakeet|gigaam]");
    };
    let Some(model_dir) = args.next() else {
        bail!("missing <model_dir>");
    };
    let input = PathBuf::from(input);
    let model_dir = PathBuf::from(model_dir);

    let mut limit_secs: Option<usize> = None;
    let mut engine = "parakeet".to_string();
    let mut clusterer = "vbx".to_string();
    let mut embed_window: Option<f32> = None;
    let rest = args.collect::<Vec<_>>();
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--limit" => {
                i += 1;
                limit_secs = Some(rest.get(i).context("--limit needs a value")?.parse()?);
            }
            "--engine" => {
                i += 1;
                engine = rest.get(i).context("--engine needs a value")?.to_string();
            }
            "--clusterer" => {
                i += 1;
                clusterer = rest.get(i).context("--clusterer needs a value")?.to_string();
            }
            "--embed-window" => {
                i += 1;
                embed_window = Some(rest.get(i).context("--embed-window needs a value")?.parse()?);
            }
            other => bail!("unknown arg: {other}"),
        }
        i += 1;
    }
    if engine != "parakeet" && engine != "gigaam" {
        bail!("--engine must be parakeet or gigaam");
    }

    let out_dir = input
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("spike")
        .to_string();

    // ---- 1. decode --------------------------------------------------------
    let t = Instant::now();
    let (samples, in_rate, channels, source_format) = decode_audio(&input)?;
    let mut samples = samples;
    let decode_s = t.elapsed().as_secs_f64();
    eprintln!(
        "[decode] {} ch={} rate={} -> mono 16k, {} samples ({:.1}s) in {:.1}s",
        source_format,
        channels,
        in_rate,
        samples.len(),
        samples.len() as f64 / TARGET_RATE as f64,
        decode_s
    );

    if let Some(lim) = limit_secs {
        let max = lim * TARGET_RATE;
        if samples.len() > max {
            samples.truncate(max);
        }
        eprintln!("[decode] limited to {}s by --limit", lim);
    }
    let audio_secs = samples.len() as f64 / TARGET_RATE as f64;

    // ---- 2. ASR (chunked) -------------------------------------------------
    let t = Instant::now();
    let (asr_result, model_desc) = match engine.as_str() {
        "parakeet" => {
            let mut model = ParakeetModel::load(&model_dir, &Quantization::Int8)
                .context("parakeet load")?;
            let model_desc = "parakeet-tdt-0.6b-v3-int8";
            let load_s = t.elapsed().as_secs_f64();
            eprintln!("[asr] model loaded in {:.1}s", load_s);

            let params = ParakeetParams {
                language: Some("ru".into()),
                timestamp_granularity: Some(TimestampGranularity::Segment),
            };
            let chunk_samples = CHUNK_SECS * TARGET_RATE;
            let total = samples.len();
            let nchunks = total.div_ceil(chunk_samples);
            let mut text = String::new();
            let mut segments: Vec<TranscriptionSegment> = Vec::new();
            for (idx, (start, end)) in chunk_ranges(total, chunk_samples).into_iter().enumerate() {
                let tc = Instant::now();
                let mut res = model
                    .transcribe_with(&samples[start..end], &params)
                    .with_context(|| format!("parakeet chunk {}/{}", idx + 1, nchunks))?;
                res.offset_timestamps(start as f32 / TARGET_RATE as f32);
                if let Some(mut segs) = res.segments.take() {
                    segments.append(&mut segs);
                }
                text.push_str(res.text.trim_end());
                text.push(' ');
                eprintln!(
                    "[asr] chunk {}/{} in {:.1}s",
                    idx + 1,
                    nchunks,
                    tc.elapsed().as_secs_f64()
                );
            }
            (TranscriptionResult { text, segments: Some(segments) }, model_desc)
        }
        "gigaam" => {
            let mut model =
                GigaAMModel::load(&model_dir, &Quantization::Int8).context("gigaam load")?;
            let model_desc = "gigaam-v3-e2e-ctc-int8";
            let load_s = t.elapsed().as_secs_f64();
            eprintln!("[asr] model loaded in {:.1}s", load_s);

            let params = Default::default();
            let chunk_samples = CHUNK_SECS * TARGET_RATE;
            let total = samples.len();
            let nchunks = total.div_ceil(chunk_samples);
            let mut text = String::new();
            for (idx, (start, end)) in chunk_ranges(total, chunk_samples).into_iter().enumerate() {
                let tc = Instant::now();
                let res = model
                    .transcribe_with(&samples[start..end], &params)
                    .with_context(|| format!("gigaam chunk {}/{}", idx + 1, nchunks))?;
                text.push_str(res.text.trim_end());
                text.push(' ');
                eprintln!(
                    "[asr] chunk {}/{} in {:.1}s",
                    idx + 1,
                    nchunks,
                    tc.elapsed().as_secs_f64()
                );
            }
            // CTC-модель без таймкодов: только текст, без сшивки спикеров.
            (TranscriptionResult { text, segments: None }, model_desc)
        }
        _ => unreachable!(),
    };
    let asr_s = t.elapsed().as_secs_f64();
    let segments = asr_result.segments.unwrap_or_default();
    eprintln!(
        "[asr] done: {} segments, {:.1}s wall / {:.1}s audio (RTF {:.2})",
        segments.len(),
        asr_s,
        audio_secs,
        asr_s / audio_secs
    );

    // ---- 3. diarization ---------------------------------------------------
    let t = Instant::now();
    let registry = polyvoice::models::ModelRegistry::default()
        .context("polyvoice model registry (auto-download ~8.4 MB)")?;
    let mut config = polyvoice::PipelineConfig::default();
    config.profile = polyvoice::types::Profile::Balanced;
    config.clusterer = match clusterer.as_str() {
        "vbx" => polyvoice::ClustererKind::Vbx,
        "ahc" => polyvoice::ClustererKind::Ahc { threshold: 0.5 },
        other => bail!("--clusterer must be vbx or ahc, got {other}"),
    };
    if let Some(w) = embed_window {
        config.embed_window_secs = Some(w);
    }
    let pipeline = polyvoice::Pipeline::builder()
        .config(config)
        .with_models_from(registry)
        .build()
        .context("polyvoice pipeline build")?;
    let dia_build_s = t.elapsed().as_secs_f64();
    eprintln!("[diar] pipeline ready in {:.1}s", dia_build_s);

    let t = Instant::now();
    let sr = polyvoice::types::SampleRate::new(TARGET_RATE as u32)
        .ok_or_else(|| anyhow::anyhow!("bad sample rate"))?;
    let dia = pipeline.run(&samples, sr).context("polyvoice run")?;
    let diar_s = t.elapsed().as_secs_f64();
    let turns: Vec<(usize, f64, f64)> = dia
        .turns
        .iter()
        .map(|turn| (turn.speaker.0 as usize, turn.time.start as f64, turn.time.end as f64))
        .collect();
    let speakers = turns.iter().map(|(s, _, _)| *s).collect::<std::collections::BTreeSet<_>>();
    eprintln!(
        "[diar] done: {} turns, {} speakers, {:.1}s wall (RTF {:.2})",
        turns.len(),
        speakers.len(),
        diar_s,
        diar_s / audio_secs
    );

    // ---- 4. merge ---------------------------------------------------------
    let t = Instant::now();
    let blocks = merge_segments_with_turns(&segments, &turns);
    let merge_s = t.elapsed().as_secs_f64();

    // ---- 5. output --------------------------------------------------------
    let out_name = format!("{}_{}", stem, engine);
    let transcript_path = out_dir.join(format!("{}_transcript.txt", out_name));
    let mut out = String::new();
    if blocks.is_empty() {
        // CTC-движок без таймкодов: текст без спикеров.
        out.push_str(asr_result.text.trim());
        out.push('\n');
    }
    for b in &blocks {
        out.push_str(&format!(
            "[{}] Спикер {}: {}\n",
            fmt_hms(b.start),
            b.speaker,
            b.text.trim()
        ));
    }
    std::fs::write(&transcript_path, out.as_bytes())?;

    let metrics = serde_json::json!({
        "input": input.display().to_string(),
        "engine": engine,
        "model": model_desc,
        "chunk_secs": CHUNK_SECS,
        "audio_secs": audio_secs,
        "stages": {
            "decode_s": decode_s,
            "asr_s": asr_s,
            "diar_build_s": dia_build_s,
            "diar_s": diar_s,
            "merge_s": merge_s,
        },
        "total_s": decode_s + asr_s + dia_build_s + diar_s + merge_s,
        "asr_rtf": asr_s / audio_secs,
        "diar_rtf": diar_s / audio_secs,
        "segments": segments.len(),
        "turns": turns.len(),
        "speakers": speakers.len(),
        "merged_blocks": blocks.len(),
    });
    let metrics_path = out_dir.join(format!("{}_metrics.json", out_name));
    std::fs::write(&metrics_path, serde_json::to_string_pretty(&metrics)?)?;

    eprintln!(
        "[done] {} blocks -> {}\nmetrics -> {}",
        blocks.len(),
        transcript_path.display(),
        metrics_path.display()
    );
    Ok(())
}

// ---- decode: symphonia (все форматы) + hound (wav), миксдаун + ресемплинг ----

fn decode_audio(path: &Path) -> Result<(Vec<f32>, u32, usize, &'static str)> {
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
    let mono = resample_to_16k(mono, rate as usize)?;
    Ok((mono, rate, channels, fmt))
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
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
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
    let sym_channels = track
        .codec_params
        .channels
        .map(|c| c.count());

    // symphonia умеет демуксить mkv/webm, но не декодировать Opus: пакеты
    // отдаём в libopus (audiopus), OpusHead даёт pre-skip и число каналов.
    if track.codec_params.codec == symphonia::core::codecs::CODEC_TYPE_OPUS {
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
        eprintln!("[decode] opus: {} ch, pre-skip {} samples", opus_channels, preskip);

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
                Err(SymError::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(SymError::ResetRequired) => bail!("stream reset required (unsupported)"),
                Err(e) => return Err(e.into()),
            };
            if packet.track_id() != track_id {
                continue;
            }
            let decoded = match opus_dec.decode_float(Some(packet.buf()), &mut frame_buf, false) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("[decode] opus packet skipped: {e}");
                    continue;
                }
            };
            interleaved.extend_from_slice(&frame_buf[..decoded * opus_channels]);
        }
        // Opus pre-skip: первые preskip сэмплов — artifacts от кодека.
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
            Err(SymError::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
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
            sample_buf = Some(SampleBuffer::<f32>::new(
                decoded.capacity() as u64,
                spec,
            ));
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

// ---- helpers --------------------------------------------------------------

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

struct MergedBlock {
    speaker: usize,
    start: f64,
    end: f64,
    text: String,
}

fn merge_segments_with_turns(segments: &[TranscriptionSegment], turns: &[(usize, f64, f64)]) -> Vec<MergedBlock> {
    // Сегменту — спикер с максимальным пересечением; при нуле — ближайший по краю.
    let mut blocks: Vec<MergedBlock> = Vec::new();
    for seg in segments {
        let (s, e) = (seg.start as f64, seg.end as f64);
        let mut best: Option<(usize, f64)> = None; // (speaker, overlap)
        for (spk, ts, te) in turns {
            let ov = e.min(*te) - s.max(*ts);
            if ov > 0.0 && best.map(|(_, b)| ov > b).unwrap_or(true) {
                best = Some((*spk, ov));
            }
        }
        let speaker = match best {
            Some((spk, _)) => spk,
            None => {
                // нет пересечения: ближайший turn
                turns
                    .iter()
                    .min_by(|a, b| {
                        let da = (a.1 - e).abs().min((a.2 - s).abs());
                        let db = (b.1 - e).abs().min((b.2 - s).abs());
                        da.partial_cmp(&db).unwrap()
                    })
                    .map(|t| t.0)
                    .unwrap_or(0)
            }
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

fn fmt_hms(secs: f64) -> String {
    let total = secs.max(0.0) as u64;
    format!("{:02}:{:02}:{:02}", total / 3600, (total % 3600) / 60, total % 60)
}
