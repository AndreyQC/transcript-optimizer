import { useMemo, useState, useEffect } from "react";
import { addEntry, findRuleLine, type AddEntryInput } from "../lib/yaml-edit";
import {
  useDictionaries,
  getGlossaryCategories,
  getSimilarityThresholds,
} from "../store/dictionaries";
import { findSimilar } from "../lib/similarity";
import {
  ACTION_HINT,
  ACTION_LABEL,
  type ContextAction,
  type Selection,
} from "./contextMenuActions";
import {
  SimilarFromPanel,
  buildFromPool,
  type SimilarCandidateRow,
} from "./SimilarFromPanel";
import type { DictKind } from "../types/dictionaries";

// Превью diff: какие строки добавились/удалились (переиспользуем логику EditPanel).
function computeDiff(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: { sign: "+" | "-" | " "; text: string }[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const la = a[i] ?? null;
    const lb = b[i] ?? null;
    if (la === lb) out.push({ sign: " ", text: la ?? "" });
    else {
      if (la !== null) out.push({ sign: "-", text: la });
      if (lb !== null) out.push({ sign: "+", text: lb });
    }
  }
  return out;
}

interface Props {
  action: ContextAction | null;
  selection: Selection | null;
  onClose: () => void;
}

// Имя секции для кнопки «Добавить в это правило»: пользователь её не видит,
// но она нужна для `appendFromSection`.
function sectionForAction(a: ContextAction): "from" | "from_lemmas" | null {
  if (a === "replace") return "from";
  // lemma — в другой словарь (lemma_irregular.yaml), не покрываем фразовой
  // фильтрацией в этой итерации (см. план, MVP — только from/from_lemmas).
  return null;
}

// Локальный sub-компонент не нужен — используем общий `SimilarFromPanel`.

// Модалка действия контекстного меню. Для replace требует to + label,
// для lemma — значение леммы, остальные — подтверждение по выделению.
export function ContextActionDialog({ action, selection, onClose }: Props) {
  const entries = useDictionaries((s) => s.entries);
  const applyEdit = useDictionaries((s) => s.applyEdit);
  const setActive = useDictionaries((s) => s.setActive);
  const setPendingScroll = useDictionaries((s) => s.setPendingScroll);
  const cats = useMemo(() => getGlossaryCategories(entries), [entries]);
  const thresholds = useMemo(() => getSimilarityThresholds(entries), [entries]);

  // Локальные поля формы.
  const [to, setTo] = useState("");
  const [label, setLabel] = useState("");
  const [lemma, setLemma] = useState("");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [pendingBefore, setPendingBefore] = useState("");
  const [done, setDone] = useState(false);

  // Режим «append to existing rule» — кнопка «Добавить в это правило».
  // Универсален по `ruleKey` и `section` (from / from_lemmas).
  const [appendTarget, setAppendTarget] = useState<{
    ruleKey: string;
    section: "from" | "from_lemmas";
  } | null>(null);
  // «Игнорировать» — помнит на время жизни диалога, сбрасывается при смене action
  // и при успешном применении. Хранится в Set<string> в state — ref не вызывает
  // ререндер, поэтому фильтрация без перерендера невозможна (useMemo дал бы тот же
  // результат до следующего setState). Set здесь — нужен редкий ререндер, и
  // он происходит только по клику «Игнорировать», так что копеечный.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Сброс формы при смене действия.
  useEffect(() => {
    if (action) {
      setTo("");
      setLabel("");
      setLemma("");
      setErr("");
      setPending(null);
      setPendingBefore("");
      setDone(false);
      setAppendTarget(null);
      setDismissed(new Set());
    }
  }, [action]);

  // Похожие from для текущего действия — мемоизированно. Пересчёт идёт по
  // текущему вводу (selection.text / form.to / appendTarget), что позволяет
  // живо реагировать на изменения.
  const similarRows: SimilarCandidateRow[] = useMemo(() => {
    if (!action || !selection) return [];
    const section = sectionForAction(action);
    if (!section) return []; // lemma идёт в lemma_irregular — вне MVP.
    // Источник кандидатов — все `from` (для replace) или `from_lemmas`.
    // Здесь берём только тот пул, который соответствует секции действия.
    const pool = buildFromPool(entries, section);
    if (pool.length === 0) return [];
    // Что именно сравниваем:
    //   - в обычном режиме — selection.text (то, что выделено в OOV/ПКМ);
    //   - если пользователь начал вводить «to» И форма в режиме append —
    //     всё равно сравниваем по selection.text, чтобы UI был стабилен.
    const target = selection.text;
    const isPhrase = target.includes(" ");
    const threshold = isPhrase ? thresholds.phrase : thresholds.word;
    const hits = findSimilar(target, pool, threshold);
    return hits.map((h) => ({
      ruleKey: h.sourceKey,
      to: h.to,
      value: h.candidate.valueNorm,
      section,
      score: h.score,
    }));
  }, [action, selection, entries, thresholds]);

  // Фильтр «Игнорировать» — отфильтрованный список для рендера.
  const visibleRows = similarRows.filter((r) => !dismissed.has(r.ruleKey));

  if (!action || !selection) return null;

  // Какой словарь правит это действие.
  function targetKind(a: ContextAction): DictKind {
    switch (a) {
      case "whitelist":
        return "whitelist";
      case "filler_word":
      case "filler_phrase":
      case "keep":
        return "filler";
      case "replace":
        return "replacements";
      case "lemma":
        return "lemma_irregular";
    }
  }

  // Построить AddEntryInput для текущего действия и формы.
  // Если режим append — НЕ используется targetKind, идёт в replacements.yaml.
  function buildInput(a: ContextAction, sel: Selection): AddEntryInput | null {
    switch (a) {
      case "whitelist":
        return { kind: "whitelist", value: sel.text };
      case "filler_word":
        return { kind: "filler", section: "filler_words", value: sel.text };
      case "filler_phrase":
        return { kind: "filler", section: "filler_phrases", value: sel.text };
      case "keep":
        return { kind: "filler", section: "keep_override", value: sel.text };
      case "replace": {
        if (!appendTarget) {
          if (!to.trim()) return null;
          if (!label.trim()) return null;
          return {
            kind: "replacements",
            to: to.trim(),
            label: label.trim(),
            from: [sel.text],
          };
        }
        // Режим append: to/label из формы не нужны (они уже существуют в правиле),
        // но проверяем, что пользователь не удалил их — `addEntry` их игнорирует,
        // но мы хотим сообщить об ошибке явно, если to пуст (защита от случайной
        // распаковки режима).
        return {
          kind: "replacements",
          appendFromToRule: appendTarget.ruleKey,
          appendFromSection: appendTarget.section,
          from: [sel.text],
        };
      }
      case "lemma": {
        if (!lemma.trim()) return null;
        return { kind: "lemma_irregular", key: sel.text, value: lemma.trim() };
      }
    }
  }

  function handlePreview() {
    setErr("");
    const input = buildInput(action!, selection!);
    if (!input) {
      setErr(
        action === "replace"
          ? appendTarget
            ? "Не выбрано правило для добавления."
            : "Заполните to и выберите категорию (label)."
          : "Укажите лемму.",
      );
      return;
    }
    const kind = targetKind(action!);
    const entry = entries.find((e) => e.kind === kind);
    if (!entry) {
      setErr(`Словарь ${kind} не открыт.`);
      return;
    }
    const res = addEntry(entry.raw, input);
    if (!res.ok) {
      setErr(res.error ?? "ошибка");
      setPending(null);
      return;
    }
    setPendingBefore(entry.raw);
    setPending(res.raw);
  }

  function handleApply() {
    if (!pending) return;
    const kind = targetKind(action!);
    applyEdit(kind, pending);
    setDone(true);
    // Автозакрытие после короткой паузы.
    setTimeout(() => onClose(), 400);
  }

  // Кнопки панели похожих from — все они работают в ветке `replace`.
  function onAppendCandidate(row: SimilarCandidateRow) {
    setErr("");
    // ВАЖНО: в режиме append нет смысла показывать форму to/label — но UX
    // требует дать пользователю возможность отменить и вернуться к «создать
    // новое правило», поэтому сохраняем appendTarget как state до применения.
    setAppendTarget({ ruleKey: row.ruleKey, section: row.section });
    // Сбрасываем текущий pending, чтобы пользователь явно нажал «Превью»
    // и увидел новый diff (merge в существующее правило).
    setPending(null);
    setDone(false);
  }

  function onOpenCandidate(row: SimilarCandidateRow) {
    const entry = entries.find((e) => e.kind === "replacements");
    if (!entry) return;
    const line = findRuleLine(entry.raw, row.ruleKey);
    setActive("replacements");
    if (line !== null) {
      setPendingScroll("replacements", row.ruleKey, line);
    }
    // Закрываем диалог — пользователю удобнее смотреть редактор.
    onClose();
  }

  function onDismissCandidate(ruleKey: string) {
    // Копируем Set, чтобы React увидел изменение и перерендерил список.
    const next = new Set(dismissed);
    next.add(ruleKey);
    setDismissed(next);
  }

  return (
    <div className="ctx-backdrop" onClick={onClose}>
      <div
        className="ctx-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="ctx-header">
          <h3>{ACTION_LABEL[action]}</h3>
          <button className="ctx-close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <div className="ctx-target">
          <span className="ctx-target-label">Выделено:</span>
          <code className="ctx-target-value">{selection.text}</code>
        </div>
        <div className="ctx-hint">{ACTION_HINT[action]}</div>

        {action === "replace" && !appendTarget && (
          <div className="ctx-form">
            <label>
              to (канонический термин)
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                autoFocus
              />
            </label>
            <label>
              label (категория глоссария)
              <select value={label} onChange={(e) => setLabel(e.target.value)}>
                <option value="">— выбрать —</option>
                {[...cats].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {action === "replace" && appendTarget && (
          <div className="ctx-form ctx-form-append">
            <div className="ctx-form-append-info">
              Будет дописано в правило <code>{appendTarget.ruleKey}</code>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => {
                  setAppendTarget(null);
                  setPending(null);
                  setDone(false);
                }}
              >
                Отмена (вернуться к «создать новое»)
              </button>
            </div>
          </div>
        )}

        {action === "lemma" && (
          <div className="ctx-form">
            <label>
              лемма (каноническая форма)
              <input
                value={lemma}
                onChange={(e) => setLemma(e.target.value)}
                autoFocus
              />
            </label>
          </div>
        )}

        {/* Панель похожих from — только для replace, до append-режима. */}
        {action === "replace" && !appendTarget && (
          <SimilarFromPanel
            scope="ctx"
            rows={visibleRows}
            onAppend={onAppendCandidate}
            onOpen={onOpenCandidate}
            onDismiss={onDismissCandidate}
          />
        )}

        {err && <div className="edit-err">{err}</div>}

        <div className="ctx-actions">
          <button onClick={handlePreview} className="btn">
            Превью
          </button>
          {pending && !done && (
            <button onClick={handleApply} className="btn">
              Применить
            </button>
          )}
          {pending && !done && (
            <button onClick={() => setPending(null)} className="btn">
              Отмена превью
            </button>
          )}
          {done && <span className="ctx-done">✓ Применено (undo доступен)</span>}
        </div>

        {pending && (
          <div className="edit-diff">
            <h4>Предпросмотр diff</h4>
            <pre>
              {computeDiff(pendingBefore, pending)
                .slice(0, 60)
                .map((l, i) => (
                  <div key={i} className={`diff-line diff-${l.sign}`}>
                    {l.sign} {l.text}
                  </div>
                ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
