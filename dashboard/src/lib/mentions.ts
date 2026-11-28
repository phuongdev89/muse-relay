// Client-side port of the server's mention matcher
// (supabase/functions/_shared/relay.ts parseMentionTargets): case-insensitive,
// longest-prefix-first (so names containing spaces win over shorter ones),
// `@all` special-cased, boundary char must not be [a-z0-9_]. Used purely for
// RENDERING (composer mirror highlight + bubble badges) — the sent text stays
// raw and the server re-parses it authoritatively.

export interface MentionSpan {
  start: number;
  end: number;
  /** matched name without the leading `@` (original roster casing) */
  name: string;
  all: boolean;
}

export function parseMentionSpans(text: string, names: string[]): MentionSpan[] {
  if (text.length === 0 || names.length === 0) return [];
  const lowered = text.toLowerCase();
  const roster = names
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .map((n) => ({ display: n, lowered: n.toLowerCase() }))
    // Longest first so `@Nyx Team` wins over a shorter `@Nyx`.
    .sort((a, b) => b.lowered.length - a.lowered.length);

  const isBoundary = (ch: string | undefined): boolean =>
    ch === undefined || !/[a-z0-9_]/.test(ch);

  const spans: MentionSpan[] = [];
  let lastEnd = -1;
  for (
    let i = lowered.indexOf("@");
    i !== -1;
    i = lowered.indexOf("@", i + 1)
  ) {
    // Overlap guard: keep spans ordered and disjoint.
    if (i < lastEnd) continue;
    const rest = lowered.slice(i + 1, i + 65);
    if (rest.startsWith("all") && isBoundary(lowered[i + 4])) {
      spans.push({ start: i, end: i + 4, name: "all", all: true });
      lastEnd = i + 4;
      continue;
    }
    for (const member of roster) {
      if (
        rest.startsWith(member.lowered) &&
        isBoundary(lowered[i + 1 + member.lowered.length])
      ) {
        spans.push({
          start: i,
          end: i + 1 + member.lowered.length,
          name: member.display,
          all: false,
        });
        lastEnd = i + 1 + member.lowered.length;
        break;
      }
    }
  }
  return spans;
}

/**
 * Splits text into plain segments and mention spans for badge rendering.
 * Mention segments carry the matched `@token` (original text casing); callers
 * wrap those in `<span class="mention-badge">` (`.is-all` for @all).
 */
export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; text: string; name: string; all: boolean };

export function splitMentionSegments(text: string, names: string[] | undefined): MentionSegment[] {
  if (!names || names.length === 0) return [{ type: "text", text }];
  const spans = parseMentionSpans(text, names);
  if (spans.length === 0) return [{ type: "text", text }];
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, span.start) });
    }
    segments.push({
      type: "mention",
      text: text.slice(span.start, span.end),
      name: span.name,
      all: span.all,
    });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }
  return segments;
}
