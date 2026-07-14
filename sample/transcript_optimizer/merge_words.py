# -*- coding: utf-8 -*-
"""
Скрипт сливает список русских слов из 10000-russian-words.txt
в YAML-словарь detector_whitelist.yaml (ключ common_words),
удаляет дубликаты и сортирует результат.
"""

import sys
from pathlib import Path

import re

import yaml

BASE_DIR = Path(r"C:\repos\personal\-=Sourcecraft=-\transcript-optimizer\sample\transcript_optimizer")
WORDS_FILE = BASE_DIR / "10000-russian-words.txt"
YAML_FILE = BASE_DIR / "detector_whitelist.yaml"

# Слово считается "чистым" если содержит только кириллицу/латиницу и опциональный дефис,
# при этом первая и последняя буква — именно буква (не дефис и не цифра).
# Отсеивает: "#8211", "$", "-что-то", одиночные символы мусора (U+FFFD, цифры, спецсимволы).
GOOD_WORD_RE = re.compile(r"^[а-яёa-z][а-яёa-z\-]*[а-яёa-z]$", re.IGNORECASE)


def is_clean_word(word: str) -> bool:
    return bool(GOOD_WORD_RE.fullmatch(word))


def main() -> int:
    if not WORDS_FILE.exists():
        print(f"[ERROR] Файл со словами не найден: {WORDS_FILE}", file=sys.stderr)
        return 1
    if not YAML_FILE.exists():
        print(f"[ERROR] YAML-словарь не найден: {YAML_FILE}", file=sys.stderr)
        return 1

    with WORDS_FILE.open("r", encoding="utf-8") as f:
        raw_words = {line.strip() for line in f if line.strip()}
    dirty_count = len(raw_words) - sum(1 for w in raw_words if is_clean_word(w))
    new_words = {w for w in raw_words if is_clean_word(w)}

    with YAML_FILE.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    existing_words = set(data.get("common_words", []) or [])
    before_total = len(existing_words) + len(new_words)
    merged = existing_words | new_words
    added = len(merged) - len(existing_words)

    # Финальная зачистка: убираем не-русские слова, которые могли уже сидеть в YAML.
    cleaned = {w for w in merged if is_clean_word(w)}
    data["common_words"] = sorted(cleaned)

    with YAML_FILE.open("w", encoding="utf-8") as f:
        yaml.safe_dump(
            data,
            f,
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
            width=4096,
        )

    print(f"[OK] Прочитано новых слов: {len(raw_words)}")
    print(f"[OK] Отброшено мусорных строк: {dirty_count}")
    print(f"[OK] Было в YAML: {len(existing_words)}")
    print(f"[OK] Добавлено уникальных: {added}")
    print(f"[OK] Дубликатов отброшено: {before_total - len(merged)}")
    print(f"[OK] Итого в common_words: {len(cleaned)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
