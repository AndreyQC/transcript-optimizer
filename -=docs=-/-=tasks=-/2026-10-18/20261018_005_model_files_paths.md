# Файлы моделей транскрибации: пути, источники, размещение

> Контекст:
> - `-=tasks=-/2026-10-18/20261018_002_transcriber_spike_result.md` — спайк,
>   §4.4 (почему закачка ручная)
> - `spike/transcriber/` — код, использующий эти модели

**Дата:** 2026-10-18
**Назначение:** перенос моделей на машины коллег (авто-закачка не работает за
корпоративным TLS-прокси: ureq получает `invalid peer certificate`).

---

## 1. Куда скачано на этой машине

### 1.1. Модели диаризации (polyvoice)

**Каталог:** `C:\Users\andrey.potapov\AppData\Local\polyvoice\models`
(= `%LOCALAPPDATA%\polyvoice\models`; это стандартный кэш polyvoice —
на Linux `~/.cache/polyvoice/models`, на macOS `~/Library/Caches/polyvoice/models`).

| Файл | Размер, Б | SHA-256 |
|---|---|---|
| silero_vad.onnx | 2 327 524 | `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3` |
| powerset_int8.onnx | 1 649 256 | `175896d26f639933cd86906d2dd3e6796eddb23c1f719925a3949052da76183b` |
| resnet34_int8.onnx | 6 765 058 | `24b58559fefb2af624a5d371c43ebae891a9a8ca363b2f9e7c31fd8e440a36b3` |
| plda_transform.npy | 131 200 | `90261469714415743f4b8a86ee6b89466db858bde3c5944367cccfb7abd34f14` |
| plda_phi_computed.npy | 1 152 | `6ef7cf2f5a23a45b66f440f9a996a4cf5c047b369829af695d50ef18aa0a35e3` |
| plda_mean1.npy | 2 176 | `e424c0c352182aa8e0f555dec1f3b30e29a20b9ed6b25d339f112af92e51e36f` |
| plda_mean2.npy | 640 | `6f6fb708a2037197b5b84ffeaa8f140cb878088fbecd6ab042ad26a7691bd2cf` |
| plda_lda.npy | 131 200 | `e20c9b012bebd1aabda5a38a127e63a43cf35debdc502715fc143e2fb6bc3c4b` |
| plda_mu.npy | 1 152 | `d286d48acf99bbc1ed1502fed0a3e361ae5626ce1870c8be9f7397c5e47886c6` |

**Откуда качать** (оригиналы; SHA-256 из манифеста polyvoice 1.0.0):

```
https://github.com/snakers4/silero-vad/raw/bfdc0193023f121ea5b3cc7b176dbed570a68a59/src/silero_vad/data/silero_vad.onnx
https://github.com/ekhodzitsky/polyvoice/releases/download/models-int8-v2/powerset_int8.onnx
https://github.com/ekhodzitsky/polyvoice/releases/download/models-int8-v2/resnet34_int8.onnx
https://raw.githubusercontent.com/ekhodzitsky/polyvoice/0623ae0b6773db7731f0fb3e75d8950347be94db/fixtures/vbx-plda/plda_transform.npy
https://raw.githubusercontent.com/ekhodzitsky/polyvoice/0623ae0b6773db7731f0fb3e75d8950347be94db/fixtures/vbx-plda/plda_phi_computed.npy
https://raw.githubusercontent.com/ekhodzitsky/polyvoice/0623ae0b6773db7731f0fb3e75d8950347be94db/fixtures/vbx-plda/plda_mean1.npy
https://raw.githubusercontent.com/ekhodzitsky/polyvoice/0623ae0b6773db7731f0fb3e75d8950347be94db/fixtures/vbx-plda/plda_mean2.npy
https://raw.githubusercontent.com/ekhodzitsky/polyvoice/0623ae0b6773db7731f0fb3e75d8950347be94db/fixtures/vbx-plda/plda_lda.npy
https://raw.githubusercontent.com/ekhodzitsky/polyvoice/0623ae0b6773db7731f0fb3e75d8950347be94db/fixtures/vbx-plda/plda_mu.npy
```

Файлы класть **напрямую в каталог** `%LOCALAPPDATA%\polyvoice\models\`
(без подкаталогов, имена как в таблице). Итого ~11 МБ. Проверка при запуске:
polyvoice сверяет SHA-256 и minisign-подпись по своему манифесту — лишние
правки файлов не пройдут.

### 1.2. Модели ASR (transcribe-rs)

На этой машине переиспользованы модели установленного AivoRelay (Store-версия):

**Каталог:** `C:\Users\andrey.potapov\AppData\Local\Packages\
MaxITService.AivoRelay_c2aycje91vjve\LocalCache\Roaming\fi.maxits.aivorelay\models`

| Модель | Каталог | Размер | Состав |
|---|---|---|---|
| parakeet-v3 (основная, ru) | `parakeet-tdt-0.6b-v3-int8` | ~640 МБ | `encoder-model.int8.onnx` (652 МБ), `decoder_joint-model.int8.onnx` (18 МБ), `nemo128.onnx` (140 КБ), `vocab.txt` (94 КБ), `config.json` |
| gigaam-v3 (сравнение, ru) | `giga-am-v3-int8` | ~215 МБ | `model.int8.onnx` (225 МБ), `vocab.txt` |

Файлы `._*` в каталогах — macOS-ресурсы из tarball, Rust-код их игнорирует.

**Откуда качать** (tarball'ы AivoRelay/Handy; распаковать — каталог с именем
модели уже внутри):

```
https://blob.handy.computer/parakeet-v3-int8.tar.gz   (~456 МБ)
  sha256: 43d37191602727524a7d8c6da0eef11c4ba24320f5b4730f1a2497befc2efa77
https://blob.handy.computer/giga-am-v3-int8.tar.gz    (~151 МБ)
  sha256: d872462268430db140b69b72e0fc4b787b194c1dbe51b58de39444d55b6da45b
```

Для коллег достаточно скопировать **два каталога моделей ASR** и **9 файлов
диаризации** (§1.1); путь к каталогу ASR передаётся в спайк аргументом
`<model_dir>`, в Phase 10 — настройкой приложения.

## 2. Куда класть у коллег (сводно)

1. `%LOCALAPPDATA%\polyvoice\models\` — 9 файлов из §1.1.
2. Любой каталог (например, `%LOCALAPPDATA%\transcript-optimizer\models\`) —
   распакованные `parakeet-tdt-0.6b-v3-int8\` и `giga-am-v3-int8\` из §1.2;
   путь указывается при запуске/в настройках.

## 3. Проверка после переноса

```powershell
# хэши (сверить с таблицами выше)
Get-FileHash -Algorithm SHA256 <файл>
# быстрый прогон спайка (10 минут от начала файла)
spike-transcriber.exe <видео.webm> <путь\parakeet-tdt-0.6b-v3-int8> --limit 600
```

Успешный прогон печатает `[asr] done: ... RTF ~0.12` и `[diar] done: ...` и
кладёт `<stem>_parakeet_transcript.txt` рядом с видео.
