import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildCues, toAss, toSrt, toVtt } from './captions.js';
import { layout, toOut, ZOOM, type Segment, type Timeline, type TimelineShot, type ZoomKey } from './timeline.js';

const run = promisify(execFile);
const FPS = 30;

export async function ffmpeg(args: string[], cwd: string, timeout = 600000): Promise<string> {
  try {
    const { stderr } = await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, timeout, windowsHide: true, maxBuffer: 1 << 26 });
    return stderr;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('FFmpeg is required to render video. Install it or set FFMPEG_PATH.');
    const e = error as { stderr?: string; message: string };
    throw new Error(`ffmpeg failed: ${(e.stderr || e.message).slice(-1500)}`);
  }
}

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();

/**
 * zoompan expressions for one segment. `it` is the segment's local time, so
 * the source time is (it + a). Each zoom is a smoothstep ramp up over 0.4 s
 * before the action, a hold, and a ramp down; the crop centre follows the
 * target box and is clamped to the frame.
 */
export function zoomExpr(zooms: ZoomKey[], a: number, b: number): { z: string; x: string; y: string } | null {
  const R = ZOOM.ramp;
  const live = zooms.filter(k => k.t - R < b && k.until + R > a);
  if (!live.length) return null;
  const T = `(it+${f(a)})`;
  const w = live.map(k => {
    const u = `(clip((${T}-${f(k.t - R)})/${R},0,1)*clip((${f(k.until + R)}-${T})/${R},0,1))`;
    return `(${u}*${u}*(3-2*${u}))`;
  });
  const sum = (parts: string[]) => parts.join('+');
  const z = `1+${sum(live.map((k, i) => `${f(k.depth - 1)}*${w[i]}`))}`;
  const W = sum(w);
  const cx = `${sum(live.map((k, i) => `${f(k.box.x + k.box.width / 2)}*${w[i]}`))}+(1-(${W}))*${ZOOM.frameW / 2}`;
  const cy = `${sum(live.map((k, i) => `${f(k.box.y + k.box.height / 2)}*${w[i]}`))}+(1-(${W}))*${ZOOM.frameH / 2}`;
  return { z, x: `clip(${cx}-iw/zoom/2,0,iw-iw/zoom)`, y: `clip(${cy}-ih/zoom/2,0,ih-ih/zoom)` };
}

function segmentChain(input: number, shot: TimelineShot, g: Segment, last: boolean, label: string): string {
  const parts = [`[${input}:v]trim=start=${f(g.in)}:end=${f(g.out)}`, 'setpts=PTS-STARTPTS', `fps=${FPS}`, `scale=${ZOOM.frameW}:${ZOOM.frameH}`];
  const zx = zoomExpr(shot.zooms, g.in, g.out);
  if (zx) parts.push(`zoompan=z='${zx.z}':x='${zx.x}':y='${zx.y}':d=1:s=${ZOOM.frameW}x${ZOOM.frameH}:fps=${FPS}`);
  parts.push(`setpts=(PTS-STARTPTS)/${f(g.speed)}`);
  if (last && shot.hold > 0) parts.push(`tpad=stop_mode=clone:stop_duration=${f(shot.hold)}`);
  return parts.join(',') + `[${label}]`;
}

export interface RenderOptions {
  name?: string;            // output base name (default "demo")
  captions?: boolean;       // burn in (default true)
  extras?: boolean;         // srt/vtt, chapters, gif, stills (F)
  shots?: string[];         // render only these shots (style samples)
}

export interface RenderResult { mp4: string; duration: number; files: string[] }

/** Renders a timeline to MP4 in one ffmpeg run: cuts, speed, zoom, holds, voice, burned-in captions, chapters. */
export async function renderTimeline(runDir: string, tlIn: Timeline, opts: RenderOptions = {}): Promise<RenderResult> {
  const name = opts.name || 'demo';
  const tl: Timeline = layout(JSON.parse(JSON.stringify({ ...tlIn, shots: tlIn.shots.filter(s => !opts.shots || opts.shots.includes(s.shotId)) })));
  const outDir = path.join(runDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];

  const videos = [...new Set(tl.shots.map(s => s.take))];
  const voices = tl.shots.filter(s => s.voice);
  const args: string[] = [];
  for (const v of videos) args.push('-i', path.resolve(runDir, v));
  for (const s of voices) args.push('-i', path.resolve(runDir, s.voice!.file));
  const nullIdx = videos.length + voices.length;
  args.push('-f', 'lavfi', '-t', f(tl.duration), '-i', 'anullsrc=r=44100:cl=stereo');

  // Chapters (one per storyboard chapter)
  const chapters: { title: string; start: number; end: number }[] = [];
  for (const s of tl.shots) {
    const last = chapters[chapters.length - 1];
    if (last && last.title === s.chapter) last.end = s.outStart + s.outDuration;
    else chapters.push({ title: s.chapter, start: s.outStart, end: s.outStart + s.outDuration });
  }
  const meta = path.join(outDir, `${name}.ffmeta`);
  fs.writeFileSync(meta, ';FFMETADATA1\n' + chapters.map(c => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.round(c.end * 1000)}\ntitle=${c.title.replace(/[=;#\\\n]/g, ' ')}\n`).join(''));
  args.push('-i', path.basename(meta));
  const metaIdx = nullIdx + 1;

  const chains: string[] = [];
  const labels: string[] = [];
  tl.shots.forEach((s, si) => s.segments.forEach((g, gi) => {
    const label = `v${si}_${gi}`;
    chains.push(segmentChain(videos.indexOf(s.take), s, g, gi === s.segments.length - 1, label));
    labels.push(`[${label}]`);
  }));
  const cues = buildCues(tl);
  const burn = opts.captions !== false && cues.length > 0;
  const assName = `${name}.ass`;
  if (burn) fs.writeFileSync(path.join(outDir, assName), toAss(cues));
  chains.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0,fps=${FPS},format=yuv420p${burn ? `,subtitles=filename=${assName}` : ''}[vout]`);
  const aLabels: string[] = [];
  voices.forEach((s, j) => {
    const ms = Math.round((s.outStart + s.voice!.offset) * 1000);
    chains.push(`[${videos.length + j}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}:all=1[a${j}]`);
    aLabels.push(`[a${j}]`);
  });
  chains.push(`[${nullIdx}:a]${aLabels.join('')}amix=inputs=${aLabels.length + 1}:normalize=0:duration=first[aout]`);

  const graphFile = path.join(outDir, `${name}.filter.txt`);
  fs.writeFileSync(graphFile, chains.join(';\n'));
  const mp4 = path.join(outDir, `${name}.mp4`);
  await ffmpeg([...args, '-/filter_complex', path.basename(graphFile), '-map', '[vout]', '-map', '[aout]', '-map_chapters', String(metaIdx),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.basename(mp4)], outDir);
  files.push(mp4);

  if (opts.extras) {
    fs.writeFileSync(path.join(outDir, `${name}.srt`), toSrt(cues));
    fs.writeFileSync(path.join(outDir, `${name}.vtt`), toVtt(cues));
    fs.writeFileSync(path.join(outDir, `${name}.chapters.txt`), chapters.map(c => `${clock(c.start)} ${c.title}`).join('\n') + '\n');
    files.push(...['srt', 'vtt', 'chapters.txt'].map(e => path.join(outDir, `${name}.${e}`)));
    await ffmpeg(['-i', path.basename(mp4), '-vf', 'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', `${name}.gif`], outDir);
    files.push(path.join(outDir, `${name}.gif`));
    files.push(...await stills(runDir, tl, outDir, path.basename(mp4)));
  }
  return { mp4, duration: tl.duration, files };
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** One still per step, from the final video at the moment the target is highlighted (F). */
async function stills(runDir: string, tl: Timeline, outDir: string, video: string): Promise<string[]> {
  const dir = path.join(outDir, 'stills');
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const s of tl.shots) {
    const take = JSON.parse(fs.readFileSync(path.resolve(runDir, s.take.replace(/\.webm$/, '.json')), 'utf8')) as { events: { type: string; t: number; stepId?: string }[] };
    for (const id of s.stepIds) {
      const act = take.events.find(e => e.type === 'act' && e.stepId === id);
      if (!act) continue;
      const file = path.join(dir, `${s.shotId}-${id}.png`);
      await ffmpeg(['-ss', f(Math.max(0, toOut(s, act.t))), '-i', video, '-frames:v', '1', file], outDir).catch(() => {});
      if (fs.existsSync(file)) out.push(file);
    }
  }
  return out;
}

export async function probeDuration(file: string): Promise<{ duration: number; streams: string[] }> {
  const { stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { windowsHide: true });
  const j = JSON.parse(stdout);
  return { duration: Number(j.format.duration), streams: j.streams.map((s: any) => s.codec_type) };
}
