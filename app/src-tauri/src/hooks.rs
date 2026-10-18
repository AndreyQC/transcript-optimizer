//! Post-processing hooks: трейт + заглушка YandexMessengerHook.
//!
//! Хук вызывается ПОСЛЕ применения замен в приложении (фронтенд зовёт
//! `run_post_hooks` с итоговым текстом и конфигом из hooks.yaml — YAML
//! парсится на фронтенде, сюда приходит готовая структура). Ошибка хука НЕ
//! роняет пайплайн — уходит событием `hook-error` в UI.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Emitter;

/// Контекст вызова хука (по плану Phase 10 §10.7).
#[derive(Debug, Clone)]
pub struct HookContext {
    pub transcript: String,
    pub preset_id: Option<String>,
    pub preset_name: Option<String>,
    pub video_path: String,
    pub meeting_date: String,
}

/// Конфиг одного хука из hooks.yaml. `options` — карта будущих параметров,
/// пока не интерпретируются.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub presets: Vec<String>,
    #[serde(default)]
    pub target: serde_json::Value,
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default)]
    pub options: std::collections::HashMap<String, serde_json::Value>,
}
fn default_format() -> String {
    "text".into()
}

impl Default for HookConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            presets: Vec::new(),
            target: serde_json::json!({"chat_id": "", "bot_token": "", "webhook_url": ""}),
            format: default_format(),
            options: Default::default(),
        }
    }
}

/// Трейт пост-обработки. Реализации не паникуют: любая ошибка — Result.
pub trait PostProcessHook {
    fn name(&self) -> &'static str;
    fn run(&self, ctx: &HookContext) -> Result<(), String>;
}

/// Заглушка: только логирование. Детали интеграции — позже (ТЗ: «не
/// реализовывать детали, только заглушку»).
pub struct YandexMessengerHook {
    pub config: HookConfig,
}

impl PostProcessHook for YandexMessengerHook {
    fn name(&self) -> &'static str {
        "yandex_messenger"
    }

    fn run(&self, ctx: &HookContext) -> Result<(), String> {
        if !self.config.enabled {
            return Ok(());
        }
        // Пресет-фильтр: пустой список = все пресеты.
        if !self.config.presets.is_empty() {
            let id = ctx.preset_id.clone().unwrap_or_default();
            if !self.config.presets.iter().any(|p| *p == id) {
                return Ok(());
            }
        }
        eprintln!(
            "[hook:yandex_messenger] STUB: transcript {} символов, video={}, date={}, target={}",
            ctx.transcript.chars().count(),
            ctx.video_path,
            ctx.meeting_date,
            self.config.target
        );
        Ok(())
    }
}

#[tauri::command]
pub fn run_post_hooks(
    app: AppHandle,
    transcript: String,
    preset_id: Option<String>,
    preset_name: Option<String>,
    video_path: String,
    yandex_messenger: Option<HookConfig>,
) -> Result<(), String> {
    let meeting_date = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("unix:{}", d.as_secs()))
        .unwrap_or_else(|_| "unknown".into());

    let ctx = HookContext {
        transcript,
        preset_id,
        preset_name,
        video_path,
        meeting_date,
    };

    let hooks: Vec<Box<dyn PostProcessHook>> = vec![Box::new(YandexMessengerHook {
        config: yandex_messenger.unwrap_or_default(),
    })];

    for hook in hooks {
        if let Err(err) = hook.run(&ctx) {
            // Ошибка хука не роняет пайплайн — событие в UI.
            let _ = app.emit(
                "hook-error",
                serde_json::json!({"hook": hook.name(), "message": err}),
            );
        }
    }
    Ok(())
}
