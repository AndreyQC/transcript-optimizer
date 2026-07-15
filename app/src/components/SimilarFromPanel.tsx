// Подкомпонент панели «Похожие from уже в словаре».
// Переиспользуется в ContextActionDialog (ветка replace) и EditPanel
// (форма на вкладке replacements).
//
// Ожидает уже отфильтрованные строки `rows` (отфильтрованные по «Игнорировать»)
// и три колбэка. Дизайн визуально наследует `.ctx-similar*`/`.edit-similar*`
// через CSS-классы ниже (определяются в App.css вместе с остальной темой).

import type { CSSProperties } from "react";
import type { DictKind, ReplacementRule, LemmaRule } from "../types/dictionaries";
import type { SimilarPoolItem } from "../lib/similarity";
import { norm as tokenNorm } from "../engine/tokenizer";

export interface SimilarCandidateRow {
  ruleKey: string;
  to: string;
  /** Нормализованное значение, что показать пользователю как «кандидата». */
  value: string;
  /** Исходное значение (как в YAML) — нужно для подсветки/превью. */
  rawValue?: string;
  section: "from" | "from_lemmas";
  /** 0..1, округлено до 2 знаков. */
  score: number;
}

interface Props {
  rows: SimilarCandidateRow[];
  onAppend: (row: SimilarCandidateRow) => void;
  onOpen: (row: SimilarCandidateRow) => void;
  onDismiss: (ruleKey: string) => void;
  /** Контейнерный CSS-класс — "ctx-similar" для диалога, "edit-similar" для EditPanel. */
  scope: "ctx" | "edit";
}

export function SimilarFromPanel({ rows, onAppend, onOpen, onDismiss, scope }: Props) {
  if (rows.length === 0) return null;
  const rootClass = scope === "ctx" ? "ctx-similar" : "edit-similar";
  return (
    <div className={rootClass} style={panelStyle}>
      <div className={`${rootClass}-title`} style={titleStyle}>
        ⚠ Похожие from уже в словаре ({rows.length})
      </div>
      <ul className={`${rootClass}-list`} style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map((r) => (
          <li
            key={`${r.ruleKey}:${r.section}:${r.value}`}
            className={`${rootClass}-row`}
            style={rowStyle}
          >
            <div style={rowMainStyle}>
              <code style={{ fontSize: "0.95em" }}>{r.value}</code>
              <span style={metaStyle}>
                <span style={{ fontFamily: "monospace" }}>{r.ruleKey}</span>
                <span>→ {r.to}</span>
                <span>{r.score.toFixed(2)}</span>
              </span>
            </div>
            <div style={actionsStyle}>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => onAppend(r)}
                title="Дописать в это правило"
              >
                + Добавить в это правило
              </button>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => onOpen(r)}
                title="Открыть правило в словаре"
              >
                Открыть
              </button>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => onDismiss(r.ruleKey)}
                title="Игнорировать подсказку для этого правила"
              >
                Игнорировать
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Инлайн-стили — минимальные дефолты. Если в App.css уже есть правила для
// .ctx-similar* / .edit-similar*, они перебьют инлайн (более специфичны).
const panelStyle: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  border: "1px solid var(--warning-border, #c4a000)",
  borderRadius: 4,
  background: "var(--warning-bg, rgba(196,160,0,0.10))",
  fontSize: "0.92em",
};
const titleStyle: CSSProperties = { fontWeight: 600, marginBottom: 6 };
const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "6px 0",
  borderTop: "1px dashed var(--warning-border, #c4a000)",
};
const rowMainStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};
const metaStyle: CSSProperties = {
  display: "inline-flex",
  gap: 8,
  alignItems: "center",
  opacity: 0.85,
  fontSize: "0.88em",
};
const actionsStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
};

// Хелпер: построить пул кандидатов для секции из текущих `entries`. Дубликат
// одноимённого хелпера в ContextActionDialog — допустим, оба компонента
// используют эту утилиту независимо (компоненты-«родственники»).
export function buildFromPool(
  entries: { kind: DictKind; data: unknown }[],
  section: "from" | "from_lemmas",
): SimilarPoolItem[] {
  const repl = entries.find((e) => e.kind === "replacements");
  if (!repl || !repl.data || typeof repl.data !== "object") return [];
  const out: SimilarPoolItem[] = [];
  const add = (rec: Record<string, unknown> | undefined, key: string, to: string) => {
    if (!rec) return;
    const list = rec[section];
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const valueNorm = tokenNorm(raw.replace(/\s+/g, " ").trim());
      if (valueNorm.length < 2) continue;
      out.push({ valueNorm, ruleKey: key, to, length: valueNorm.length });
    }
  };
  const data = repl.data as {
    replacements?: Record<string, ReplacementRule>;
    lemma_replacements?: Record<string, LemmaRule>;
  };
  for (const [k, rule] of Object.entries(data.replacements ?? {})) {
    add(rule as unknown as Record<string, unknown>, k, String(rule.to ?? ""));
  }
  for (const [k, rule] of Object.entries(data.lemma_replacements ?? {})) {
    add(rule as unknown as Record<string, unknown>, k, String(rule.to ?? ""));
  }
  return out;
}
