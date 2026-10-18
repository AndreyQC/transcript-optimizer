//! Sidecar-бинарь пайплайна транскрибации. stdio JSON-lines протокол:
//! каждая строка stdout — JSON-событие; stderr — диагностические сообщения.

use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde_json::json;

fn emit(event: serde_json::Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{event}");
    let _ = stdout.flush();
}

fn emit_stage(stage: &str, i: usize, n: usize, secs: f64) {
    emit(json!({"event": "stage", "stage": stage, "i": i, "n": n, "secs": secs}));
}

fn main() {
    if let Err(err) = run() {
        emit(json!({"event": "error", "message": format!("{err:#}")}));
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(input) = args.next() else {
        bail!("usage: pipeline <input> <model_dir> [options]");
    };
    let Some(model_dir) = args.next() else {
        bail!("missing <model_dir>");
    };
    let input = PathBuf::from(input);
    let model_dir = PathBuf::from(model_dir);

    let mut limit_secs: Option<usize> = None;
    let mut engine = pipeline::EngineKind::Parakeet;
    let mut clusterer = pipeline::ClustererOpt::Vbx;
    let mut embed_window: Option<f32> = None;
    let mut max_speakers: Option<u8> = None;
    let mut chunk_secs: usize = 120;

    let rest = args.collect::<Vec<_>>();
    let mut i = 0;
    macro_rules! val {
        ($name:expr) => {{
            i += 1;
            rest.get(i)
                .cloned()
                .with_context(|| format!("{} needs a value", $name))?
        }};
    }
    while i < rest.len() {
        match rest[i].as_str() {
            "--limit" => limit_secs = Some(val!("--limit").parse()?),
            "--engine" => {
                engine = match val!("--engine").as_str() {
                    "parakeet" => pipeline::EngineKind::Parakeet,
                    "gigaam" => pipeline::EngineKind::GigaAm,
                    other => bail!("--engine must be parakeet or gigaam, got {other}"),
                }
            }
            "--clusterer" => {
                clusterer = match val!("--clusterer").as_str() {
                    "vbx" => pipeline::ClustererOpt::Vbx,
                    "ahc" => pipeline::ClustererOpt::Ahc { threshold: 0.5 },
                    other => bail!("--clusterer must be vbx or ahc, got {other}"),
                }
            }
            "--embed-window" => embed_window = Some(val!("--embed-window").parse()?),
            "--max-speakers" => max_speakers = Some(val!("--max-speakers").parse()?),
            "--chunk-secs" => chunk_secs = val!("--chunk-secs").parse()?,
            other => bail!("unknown arg: {other}"),
        }
        i += 1;
    }

    // ---- decode ----
    emit_stage("decode", 0, 1, 0.0);
    let decoded = pipeline::decode_audio(&input, limit_secs)?;
    eprintln!(
        "[decode] {} ch={} rate={} -> mono 16k, {:.1}s audio in {:.1}s{}",
        decoded.format,
        decoded.channels,
        decoded.source_rate,
        decoded.audio_secs,
        decoded.decode_secs,
        if decoded.limited { " (limited)" } else { "" }
    );
    emit_stage("decode", 1, 1, decoded.decode_secs);
    let samples = decoded.samples;

    // ---- ASR ----
    emit_stage("asr", 0, 1, 0.0);
    let asr = pipeline::run_asr(&samples, engine, &model_dir, chunk_secs, &mut |i, n, secs| {
        emit_stage("asr", i, n, secs);
    })?;
    eprintln!(
        "[asr] {} segments, RTF {:.3}",
        asr.segments.len(),
        asr.asr_secs / decoded.audio_secs
    );

    // ---- diarization ----
    emit_stage("diar", 0, 1, 0.0);
    let dia = pipeline::run_diarization(&samples, &clusterer, embed_window, max_speakers)?;
    eprintln!("[diar] {} turns, {} speakers", dia.turns.len(), dia.speakers);
    emit_stage("diar", 1, 1, dia.diar_secs);

    // ---- merge + result ----
    emit_stage("merge", 0, 1, 0.0);
    let blocks = pipeline::merge_segments_with_turns(&asr.segments, &dia.turns);
    emit_stage("merge", 1, 1, 0.0);

    emit(json!({
        "event": "done",
        "result": {
            "text": asr.text,
            "segments": asr.segments,
            "turns": dia.turns,
            "blocks": blocks,
            "audio_secs": decoded.audio_secs,
            "model": asr.model,
            "timings": {
                "decode_s": decoded.decode_secs,
                "asr_load_s": asr.load_secs,
                "asr_s": asr.asr_secs,
                "diar_build_s": dia.build_secs,
                "diar_s": dia.diar_secs,
            },
        }
    }));
    Ok(())
}
