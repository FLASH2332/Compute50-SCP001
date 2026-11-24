import type { Timeline } from './timeline.js';

export interface Cue { start: number; end: number; text: string }

const MAX_CHARS = 42;
const MIN_CUE = 1.0;

/** Word timings → caption cues: ≤ 42 chars per line, break at sentence ends, ≥ 1 s each. */
export function buildCues(tl: Timeline): Cue[] {
  const cues: Cue[] = [];
  for (const s of tl.shots) {
    if (!s.voice) continue;
    const base = s.outStart + s.voice.offset;
    let cur: Cue | null = null;
    for (const w of s.voice.words) {
      const text = cur ? `${cur.text} ${w.text}` : w.text;
      if (cur && text.length > MAX_CHARS) { cues.push(cur); cur = null; }
      if (!cur) cur = { start: base + w.start, end: base + w.end, text: w.text };
      else { cur.text = text; cur.end = base + w.end; }
      if (/[.!?]$/.test(w.text) && cur.text.length > 12) { cues.push(cur); cur = null; }
    }
    if (cur) cues.push(cur);
  }
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.start ?? Infinity;
    if (cues[i].end - cues[i].start < MIN_CUE) cues[i].end = Math.min(cues[i].start + MIN_CUE, next - 0.05);
    cues[i].end = Math.max(cues[i].end, cues[i].start + 0.3);
  }
  return cues;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const clock = (t: number, sep: string) => {
  const ms = Math.round(t * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
};

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${clock(c.start, ',')} --> ${clock(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function toVtt(cues: Cue[]): string {
  return 'WEBVTT\n\n' + cues.map(c => `${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${c.text}\n`).join('\n');
}

export function toAss(cues: Cue[], width = 1280, height = 720): string {
  const t = (s: number) => { const cs = Math.round(s * 100); return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`; };
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, '\\N');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,3,10,0,2,80,80,36,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cues.map(c => `Dialogue: 0,${t(c.start)},${t(c.end)},Default,,0,0,0,,${esc(c.text)}`).join('\n')}
`;
}
