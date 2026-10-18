//! Запуск sidecar-пайплайна транскрибации (`binaries/pipeline*.exe`).
//!
//! Протокол: sidecar пишет JSON-lines в stdout (stage/done/error), мы парсим
//! каждую строку и пробрасываем в webview событием `transcribe-event`.
//! Отмена — `transcribe_cancel` убивает дочерний процесс.

use std::sync::Mutex;

use tauri::AppHandle;
use tauri::Emitter;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

static CHILD: Mutex<Option<CommandChild>> = Mutex::new(None);

fn clear_child() {
    let mut guard = CHILD.lock().unwrap();
    *guard = None;
}

#[tauri::command]
pub async fn run_transcription(
    app: AppHandle,
    input: String,
    model_dir: String,
    engine: Option<String>,
    chunk_secs: Option<usize>,
    limit_secs: Option<usize>,
    max_speakers: Option<u8>,
    clusterer: Option<String>,
) -> Result<(), String> {
    // Один пайплайн за раз: повторный запуск при живом процессе — ошибка.
    {
        let guard = CHILD.lock().unwrap();
        if guard.is_some() {
            return Err("Транскрибация уже запущена".into());
        }
    }

    let mut cmd = app
        .shell()
        .sidecar("pipeline")
        .map_err(|e| format!("sidecar не найден (сборка: node scripts/build-pipeline.mjs): {e}"))?
        .args([&input, &model_dir]);

    if let Some(engine) = &engine {
        cmd = cmd.args(["--engine", engine]);
    }
    if let Some(chunk) = chunk_secs {
        cmd = cmd.args(["--chunk-secs", &chunk.to_string()]);
    }
    if let Some(limit) = limit_secs {
        cmd = cmd.args(["--limit", &limit.to_string()]);
    }
    if let Some(max) = max_speakers {
        cmd = cmd.args(["--max-speakers", &max.to_string()]);
    }
    if let Some(clusterer) = &clusterer {
        cmd = cmd.args(["--clusterer", clusterer]);
    }

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("не удалось запустить pipeline: {e}"))?;
    *CHILD.lock().unwrap() = Some(child);

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).trim().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<serde_json::Value>(&text) {
                        Ok(v) => {
                            let is_terminal = v.get("event").and_then(|e| e.as_str())
                                == Some("done")
                                || v.get("event").and_then(|e| e.as_str()) == Some("error");
                            let _ = app.emit("transcribe-event", &v);
                            if is_terminal {
                                clear_child();
                            }
                        }
                        Err(_) => eprintln!("[pipeline:stdout] {text}"),
                    }
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[pipeline:stderr] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(_) => {
                    clear_child();
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn transcribe_cancel() -> Result<(), String> {
    let mut guard = CHILD.lock().unwrap();
    if let Some(child) = guard.take() {
        child.kill().map_err(|e| format!("не удалось остановить pipeline: {e}"))?;
    }
    Ok(())
}

/// Найти каталог моделей установленного AivoRelay (Store-версия хранит их в
/// %LOCALAPPDATA%\Packages\MaxITService.AivoRelay_*\...\models). Возвращаем
/// путь к каталогу models, из которого UI подставляет подкаталог конкретной
/// модели; None — AivoRelay не найден.
#[tauri::command]
pub fn detect_aivo_model_dir() -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let packages = std::path::Path::new(&local).join("Packages");
    let entries = std::fs::read_dir(&packages).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().contains("aivorelay") {
            continue;
        }
        let models = entry
            .path()
            .join("LocalCache")
            .join("Roaming")
            .join("fi.maxits.aivorelay")
            .join("models");
        if models.is_dir() {
            return Some(models.to_string_lossy().into_owned());
        }
    }
    None
}
