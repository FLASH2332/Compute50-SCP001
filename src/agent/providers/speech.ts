import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Speech, SpeechClip, Word } from '../core/ports.js';

/** Caches clips by hash of (provider, voice, speed, text) in the target dir. */
abstract class CachedSpeech implements Speech {
  protected abstract key: string;
  protected abstract make(text: string, dir: string, base: string, speed: number): Promise<SpeechClip>;
  async synthesize(text: string, dir: string, speed = 1): Promise<SpeechClip> {
    fs.mkdirSync(dir, { recursive: true });
    const base = crypto.createHash('sha256').update([this.key, speed, text].join('|')).digest('hex').slice(0, 16);
    const meta = path.join(dir, `${base}.json`);
    if (fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, 'utf8'));
    const clip = await this.make(text, dir, base, speed);
    fs.writeFileSync(meta, JSON.stringify(clip));
    return clip;
  }
}

/** ElevenLabs `with-timestamps`: real voice and character timings → word timings. */
export class ElevenLabsSpeech extends CachedSpeech {
  protected key: string;
  constructor(private apiKey: string, private voice = 'JBFqnCBsd6RMkjVDRZzb', private model = 'eleven_flash_v2_5') {
    super();
    this.key = `elevenlabs|${voice}|${model}`;
  }
  protected async make(text: string, dir: string, base: string, speed: number): Promise<SpeechClip> {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voice)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: this.model, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: Math.max(0.7, Math.min(1.2, speed)) } }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json() as { audio_base64: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } };
    const file = `${base}.mp3`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(body.audio_base64, 'base64'));
    const al = body.alignment;
    if (!al) return { file, duration: estimateDuration(text, speed), words: estimateWords(text, speed) };
    return { file, duration: al.character_end_times_seconds[al.character_end_times_seconds.length - 1], words: wordsFromChars(al.characters, al.character_start_times_seconds, al.character_end_times_seconds) };
  }
}

/** No voice: a silent WAV of the estimated length with estimated word timings (captions still work). */
export class SilentSpeech extends CachedSpeech {
  protected key = 'silent';
  protected async make(text: string, dir: string, base: string, speed: number): Promise<SpeechClip> {
    const duration = estimateDuration(text, speed);
    const file = `${base}.wav`;
    fs.writeFileSync(path.join(dir, file), silentWav(duration));
    return { file, duration, words: estimateWords(text, speed) };
  }
}

export function speechFromEnv(env = process.env): Speech {
  return env.ELEVENLABS_API_KEY ? new ElevenLabsSpeech(env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID || undefined, env.ELEVENLABS_MODEL || undefined) : new SilentSpeech();
}

export function wordsFromChars(chars: string[], starts: number[], ends: number[]): Word[] {
  const words: Word[] = [];
  let cur: Word | null = null;
  chars.forEach((c, i) => {
    if (/\s/.test(c)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { text: c, start: starts[i], end: ends[i] };
    else { cur.text += c; cur.end = ends[i]; }
  });
  if (cur) words.push(cur);
  return words;
}

const WPS = 2.6;
export const estimateDuration = (text: string, speed = 1) => Math.round((text.split(/\s+/).filter(Boolean).length / (WPS * speed) + 0.2) * 1000) / 1000;

export function estimateWords(text: string, speed = 1): Word[] {
  const ws = text.split(/\s+/).filter(Boolean);
  const total = estimateDuration(text, speed) - 0.2;
  const chars = ws.reduce((t, w) => t + w.length + 1, 0);
  let t = 0.1;
  return ws.map(w => { const d = total * (w.length + 1) / chars; const word = { text: w, start: t, end: t + d * 0.9 }; t += d; return word; });
}

function silentWav(seconds: number, rate = 22050): Buffer {
  const n = Math.ceil(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
