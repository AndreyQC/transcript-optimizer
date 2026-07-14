// Токенизатор смешанного рус/англ текста (idea.md §8.3.1).
// Требования:
//   - сохранять дефис-соединения (код-ревью, mini-max) как один токен;
//   - не рвать англо-термины (DeckBody, HTML, Markdown);
//   - апостроф внутри слова (don't) — часть токена;
//   - кавычки и пунктуация — разделители.
// Возвращает токены с offset (0-based) для построения decorations.

export interface Token {
  value: string; // как в тексте (без нормализации регистра)
  start: number; // 0-based индекс начала в исходной строке
  end: number; // 0-based индекс конца (эксклюзивно)
}

// Буква/цифра — Unicode; внутренний разделитель — дефис или апостроф,
// но только между буквами (не в начале/конце токена).
// \u2019 = типографский апостроф (’), используется в англ.
const TOKEN_RE = /[\p{L}\p{N}]+(?:[-'\u2019][\p{L}\p{N}]+)*/gu;

// Разбить строку на токены. offset-ы — относительно переданной строки.
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    const value = m[0];
    tokens.push({ value, start, end: start + value.length });
  }
  return tokens;
}

// Нормализация для сравнения: нижний регистр. Используется правилами при
// матчинге from/whitelist (регистронезависимое сравнение, idea §10.1).
export function norm(s: string): string {
  return s.toLowerCase();
}
