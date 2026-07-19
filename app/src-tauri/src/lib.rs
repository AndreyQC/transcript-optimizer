use futures_util::StreamExt;
use tauri::ipc::Channel;
use tauri_plugin_http::reqwest;

mod crypto;

// Один чанк SSE-стрима, прокидываемый во фронтенд через Channel.
// `data` — сырые байты ответа; фронтенд парсит SSE-формат сам (толерантно).
#[derive(serde::Serialize)]
struct StreamChunk {
    data: Vec<u8>,
}

// Прочитать OpenAI-ключ из окружения процесса (задаётся через `setx` или
// переменные оболочки). Возвращается во фронтенд как Option<String>: None —
// ключ не задан или пустой.
#[tauri::command]
fn get_openai_api_key() -> Option<String> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
}

// Сгенерировать новый Fernet-ключ (base64-url, 32 bytes). Используется во
// фронтенд-UI для создания env-переменной шифрования.
#[tauri::command]
fn generate_fernet_key() -> String {
    crypto::generate_fernet_key()
}

// Зашифровать plaintext с ключом из env `env_var` и вернуть строку вида
// `crypto__<env_var>__<ciphertext>`.
#[tauri::command]
fn encrypt_text(plaintext: String, env_var: String) -> Result<String, String> {
    crypto::encrypt_text(&plaintext, &env_var)
}

// Расшифровать crypto-токен. Если строка не в формате crypto__ — вернуть как есть.
#[tauri::command]
fn resolve_crypto_token(token: String) -> Result<String, String> {
    crypto::resolve_value(&token)
}

// Стриминг чат-комплишена в стиле OpenAI. Запрос идёт из Rust (минуя webview
// CORS), инкрементальные байты ответа прокидываются во фронтенд через Channel.
//
// `base_url` — полный base с /v1 (напр. `https://api.openai.com/v1`); путь
// `/chat/completions` склеивается здесь. `/v1` НЕ добавляем автоматически.
//
// `base_url` и `api_key` могут быть либо plain-значениями, либо в формате
// `crypto__<ENV>__<ciphertext>`. В последнем случае Rust расшифровывает их
// через ключ из соответствующей переменной окружения.
#[tauri::command]
async fn stream_chat(
    base_url: String,
    api_key: String,
    body: serde_json::Value,
    on_event: Channel<StreamChunk>,
) -> Result<(), String> {
    // Расшифровываем sensitive-поля, если они в crypto-формате.
    let base_url = crypto::resolve_value(&base_url)
        .map_err(|e| format!("Ошибка расшифровки base_url: {e}"))?;
    let api_key = crypto::resolve_value(&api_key)
        .map_err(|e| format!("Ошибка расшифровки api_key: {e}"))?;

    // Нормализуем base: убираем trailing '/', склеиваем с путём эндпоинта.
    let trimmed = base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", trimmed);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP-запрос упал: {e}"))?;

    // HTTP-ошибка от провайдера (4xx/5xx) — отдаём статус и тело, чтобы
    // фронтенд мог показать понятное сообщение.
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("чтение стрима: {e}"))?;
        on_event
            .send(StreamChunk {
                data: bytes.to_vec(),
            })
            .map_err(|e| format!("отправка чанка: {e}"))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_openai_api_key,
            generate_fernet_key,
            encrypt_text,
            resolve_crypto_token,
            stream_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

