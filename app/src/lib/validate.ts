import { parseDocument, LineCounter, isMap, isSeq, isScalar } from "yaml";
import type { DictEntry, DictKind } from "../types/dictionaries";

export type Severity = "error" | "warning";

// Одна найденная проблема с позицией для Monaco marker (1-based line/col).
export interface ValidationIssue {
  line: number; // 1-based
  col: number; // 1-based
  endLine: number;
  endCol: number;
  severity: Severity;
  message: string;
  rule: string; // короткий код правила для фильтрации/легенды
}

// Зависимости валидации: для replacements нужно знать категории glossary.
export interface ValidationContext {
  glossaryCategories?: Set<string>; // id категорий из glossary.yaml
}

export interface ValidationResult {
  issues: ValidationIssue[];
}

// Главная точка входа: валидирует один файл по его kind.
export function validateDictionary(
  entry: DictEntry,
  ctx: ValidationContext = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const lc = new LineCounter();
  const doc = parseDocument(entry.raw, { lineCounter: lc });

  for (const err of doc.errors) pushYamlErr(err, lc, "error", "yaml:parse", issues);
  for (const warn of doc.warnings) pushYamlErr(warn, lc, "warning", "yaml:parse", issues);
  if (doc.errors.length > 0 || !doc.contents) return { issues };

  switch (entry.kind) {
    case "replacements":
      validateReplacements(doc.contents, lc, ctx, issues);
      break;
    case "glossary":
      validateGlossary(doc.contents, lc, issues);
      break;
    case "settings":
    case "filler":
    case "lemma_irregular":
    case "whitelist":
      validateSimpleShape(entry.kind, doc.contents, lc, issues);
      break;
  }

  return { issues };
}

// --- Низкоуровневые типы для CST-обхода -----------------------------------

interface NodeLike {
  range?: [number, number, number] | null;
  value?: unknown;
  items?: unknown[];
}

function pushYamlErr(
  err: { message: string; linePos?: { line: number; col: number }[]; pos?: [number, number] },
  lc: LineCounter,
  severity: Severity,
  rule: string,
  issues: ValidationIssue[],
): void {
  let line = 1, col = 1, endLine = 1, endCol = 2;
  if (err.linePos && err.linePos.length >= 1) {
    const s = err.linePos[0];
    const e = err.linePos[err.linePos.length - 1];
    line = s.line; col = s.col; endLine = e.line; endCol = e.col + 1;
  } else if (err.pos) {
    const s = lc.linePos(err.pos[0]);
    const e = lc.linePos(err.pos[1] ?? err.pos[0] + 1);
    line = s.line; col = s.col; endLine = e.line; endCol = e.col + 1;
  }
  issues.push({ line, col, endLine, endCol, severity, message: err.message, rule });
}

// Маркер на диапазон узла.
function issueAtNode(
  node: NodeLike | null | undefined,
  lc: LineCounter,
  severity: Severity,
  rule: string,
  message: string,
): ValidationIssue {
  const r = node?.range ?? null;
  const s = r ? lc.linePos(r[0]) : { line: 1, col: 1 };
  const e = r ? lc.linePos(r[1]) : s;
  return { line: s.line, col: s.col, endLine: e.line, endCol: e.col + 1, severity, message, rule };
}

// Найти секцию верхнего уровня по имени в map-корне.
function findSection(root: unknown, name: string): NodeLike | null {
  if (!isMap(root)) return null;
  for (const pair of root.items) {
    const k = (pair.key as NodeLike)?.value;
    if (k === name) return pair.value as NodeLike;
  }
  return null;
}

// --- Валидаторы по kind ----------------------------------------------------

function validateReplacements(
  root: unknown,
  lc: LineCounter,
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  const cats = ctx.glossaryCategories;
  const seenFrom = new Map<string, string>(); // from(lower) -> rule key
  const seenTo = new Map<string, string>(); // to(lower) -> rule key
  const allTo = new Set<string>();

  const checkBlock = (block: NodeLike | null, fromField: string, blockName: string) => {
    if (!block) return;
    if (!isMap(block)) {
      issues.push(issueAtNode(block, lc, "error", "replacements:shape", `«${blockName}» должен быть отображением`));
      return;
    }
    for (const pair of (block.items ?? [])) {
      const keyNode = (pair as { key?: NodeLike }).key;
      const ruleKey = String(keyNode?.value ?? "");
      const v = (pair as { value?: NodeLike }).value;
      if (!isMap(v)) {
        issues.push(issueAtNode(keyNode, lc, "error", "replacements:shape", `${ruleKey}: ожидается map`));
        continue;
      }

      // to — обязательно + уникальность.
      const toNode = findSection(v, "to");
      if (!toNode || !isScalar(toNode)) {
        issues.push(issueAtNode(keyNode, lc, "error", "replacements:to-missing", `${ruleKey}: обязательное поле «to» отсутствует`));
      } else {
        const toVal = String(toNode.value).toLowerCase();
        const prev = seenTo.get(toVal);
        if (prev) {
          issues.push(issueAtNode(toNode, lc, "error", "replacements:to-duplicate", `${ruleKey}: «to» уже используется в ${prev}`));
        } else {
          seenTo.set(toVal, ruleKey);
        }
        allTo.add(toVal);
      }

      // label — обязательно + ∈ glossary.
      const labelNode = findSection(v, "label");
      if (!labelNode || !isScalar(labelNode)) {
        issues.push(issueAtNode(keyNode, lc, "error", "replacements:label-missing", `${ruleKey}: обязательное поле «label» отсутствует`));
      } else if (cats && cats.size > 0) {
        const lv = String(labelNode.value);
        if (!cats.has(lv)) {
          issues.push(issueAtNode(labelNode, lc, "error", "replacements:label-unknown", `${ruleKey}: неизвестная категория «${lv}» (нет в glossary.yaml)`));
        }
      }

      // from/from_lemmas — обязательно, список.
      const fromNode = findSection(v, fromField);
      if (!fromNode) {
        issues.push(issueAtNode(keyNode, lc, "error", "replacements:from-missing", `${ruleKey}: обязательное поле «${fromField}» отсутствует`));
      } else if (!isSeq(fromNode)) {
        issues.push(issueAtNode(fromNode, lc, "error", "replacements:from-shape", `${ruleKey}: «${fromField}» должен быть списком`));
      } else {
        const localSeen = new Set<string>();
        for (const item of (fromNode.items ?? [])) {
          const it = item as NodeLike;
          if (!isScalar(it)) continue;
          const fv = String(it.value).toLowerCase();
          if (localSeen.has(fv)) {
            issues.push(issueAtNode(it, lc, "warning", "replacements:from-inner-dup", `${ruleKey}: дубликат «${it.value}» внутри ${fromField}`));
          }
          localSeen.add(fv);
          const conflictRule = seenFrom.get(fv);
          if (conflictRule) {
            issues.push(issueAtNode(it, lc, "error", "replacements:from-conflict", `${ruleKey}: «${it.value}» уже в ${conflictRule}`));
          } else {
            seenFrom.set(fv, ruleKey);
          }
        }
      }
    }
  };

  checkBlock(findSection(root, "replacements"), "from", "replacements");
  checkBlock(findSection(root, "lemma_replacements"), "from_lemmas", "lemma_replacements");

  // Цепочки: to одного правила не должен быть from другого.
  for (const [fromVal, ruleKey] of seenFrom) {
    if (allTo.has(fromVal)) {
      issues.push({ line: 1, col: 1, endLine: 1, endCol: 2, severity: "error", message: `${ruleKey}: «${fromVal}» является «to» другого правила — образуется цепочка замен`, rule: "replacements:chain" });
    }
  }
}

function validateGlossary(root: unknown, lc: LineCounter, issues: ValidationIssue[]): void {
  const cats = findSection(root, "categories");
  if (!cats) {
    issues.push({ line: 1, col: 1, endLine: 1, endCol: 2, severity: "error", message: "Отсутствует секция «categories»", rule: "glossary:shape" });
    return;
  }
  if (!isMap(cats)) {
    issues.push(issueAtNode(cats, lc, "error", "glossary:shape", "«categories» должен быть отображением"));
    return;
  }
  for (const pair of (cats.items ?? [])) {
    const keyNode = (pair as { key?: NodeLike }).key;
    const id = String(keyNode?.value ?? "");
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      issues.push(issueAtNode(keyNode, lc, "warning", "glossary:id", `id категории «${id}» — рекомендуется snake_case`));
    }
    const v = (pair as { value?: NodeLike }).value;
    if (!isMap(v)) {
      issues.push(issueAtNode(keyNode, lc, "error", "glossary:shape", `Категория «${id}»: ожидается map`));
      continue;
    }
    if (!findSection(v, "title")) {
      issues.push(issueAtNode(keyNode, lc, "error", "glossary:title", `Категория «${id}»: обязательное поле «title» отсутствует`));
    }
  }
}

function validateSimpleShape(
  kind: DictKind,
  root: unknown,
  lc: LineCounter,
  issues: ValidationIssue[],
): void {
  const topKey: Record<string, string> = {
    settings: "settings",
    filler: "filler_words",
    lemma_irregular: "lemma_irregular",
    whitelist: "common_words",
  };
  const name = topKey[kind];
  const node = findSection(root, name);
  if (!node) {
    issues.push({ line: 1, col: 1, endLine: 1, endCol: 2, severity: "error", message: `Отсутствует секция «${name}»`, rule: `${kind}:shape` });
    return;
  }
  if (kind === "filler") {
    for (const f of ["filler_words", "filler_phrases", "keep_override"]) {
      const n = findSection(root, f);
      if (n && !isSeq(n)) issues.push(issueAtNode(n, lc, "error", "filler:shape", `«${f}» должен быть списком`));
    }
  } else if (kind === "whitelist") {
    if (!isSeq(node)) issues.push(issueAtNode(node, lc, "error", "whitelist:shape", "«common_words» должен быть списком"));
  } else if (kind === "settings" || kind === "lemma_irregular") {
    if (!isMap(node)) issues.push(issueAtNode(node, lc, "error", `${kind}:shape`, `«${name}» должен быть отображением`));
  }
}
