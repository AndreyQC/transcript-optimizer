import { useMemo, useState } from "react";
import type { OovRow } from "../engine/oov-stats";

interface Props {
  rows: OovRow[];
  // Колбэк добавления выделенных слов в whitelist (values = исходные написания).
  onAddWhitelist: (words: string[]) => void;
  // Колбэк добавления одного слова в replacement (диалог to + label).
  onAddReplacement: (word: string) => void;
  // Краткий статус последней операции (например, «Добавлено: 3»).
  status?: string;
}

// Грид OOV-слов с множественным селектом и кнопками добавления в словари.
// Ключ выделения — нормализованная форма (как в движке), чтобы «Привет» и
// «привет» считались одним словом. Отображается исходное написание.
export function OovStatsGrid({ rows, onAddWhitelist, onAddReplacement, status }: Props) {
  // Выделенные строки по norm-ключу.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const allSelected = rows.length > 0 && selected.size === rows.length;

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.norm)));
    }
  };

  // Выделенные строки (для надписи и кнопок).
  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.norm)),
    [rows, selected],
  );

  const canWhitelist = selectedRows.length > 0;
  // В replacement — ровно одно слово (требование ТЗ).
  const canReplacement = selectedRows.length === 1;

  return (
    <div className="oov-grid-wrap">
      <div className="oov-grid-scroll">
        <table className="stats-table oov-grid">
          <thead>
            <tr>
              <th className="oov-col-check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Выбрать все"
                  disabled={rows.length === 0}
                />
              </th>
              <th>Слово</th>
              <th className="oov-col-count">Кол-во</th>
              <th className="oov-col-type">Тип</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.norm}
                className={selected.has(r.norm) ? "oov-row-selected" : undefined}
                onClick={() => toggle(r.norm)}
              >
                <td
                  className="oov-col-check"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(r.norm)}
                    onChange={() => toggle(r.norm)}
                    aria-label={`Выбрать ${r.display}`}
                  />
                </td>
                <td className="mono">{r.display}</td>
                <td className="oov-col-count">{r.count}</td>
                <td className="oov-col-type">
                  <span
                    className={`oov-badge oov-badge-${r.category}`}
                    title={r.category === "oov" ? "Вне словарей" : "Короче min_word_len"}
                  >
                    {r.category === "oov" ? "OOV" : "short"}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="oov-empty">
                  Подозрительных слов нет.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="oov-footer">
        <span className="oov-selected-count">
          Выбрано: <b>{selectedRows.length}</b>
        </span>
        <div className="oov-footer-actions">
          <button
            className="btn-mini"
            disabled={!canWhitelist}
            onClick={() => {
              onAddWhitelist(selectedRows.map((r) => r.display));
              setSelected(new Set());
            }}
            title={
              canWhitelist
                ? "Добавить все выделенные в detector_whitelist"
                : "Выделите хотя бы одно слово"
            }
          >
            Добавить в whitelist
          </button>
          <button
            className="btn-mini"
            disabled={!canReplacement}
            onClick={() => {
              onAddReplacement(selectedRows[0].display);
            }}
            title={
              canReplacement
                ? "Добавить в replacements (диалог)"
                : "Выберите ровно одно слово"
            }
          >
            Добавить в replacement
          </button>
        </div>
        {status && <span className="oov-status">{status}</span>}
      </div>
    </div>
  );
}
