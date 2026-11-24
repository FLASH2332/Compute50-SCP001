import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { DemoScene } from './plan.js';

const run = promisify(execFile);
const escape = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const styles = `
*{box-sizing:border-box}body{margin:0;background:#101620;color:#f2f4f8;font:16px system-ui,sans-serif}
main{max-width:1136px;margin:auto;padding:24px 32px}header{display:flex;justify-content:space-between;align-items:center;gap:16px}
h1{font-size:24px;margin:0 0 6px}p{margin:0;color:#a7b5c8}small{white-space:nowrap;color:#a7b5c8}
.screen{position:relative;width:min(100%,800px);margin:16px auto 0}.screen img{width:100%;display:block;border-radius:10px;border:1px solid #354256}
.marker{position:absolute;transform:translate(-50%,-50%);width:38px;height:38px;border:3px solid #fff;border-radius:50%;background:#1767e1dd;box-shadow:0 0 0 8px #1767e15c;cursor:pointer}
footer{margin-top:14px;display:flex;justify-content:center;gap:10px}button{border:1px solid #43516a;border-radius:7px;background:#24324a;color:#fff;padding:8px 16px;cursor:pointer}
button:disabled{opacity:.4;cursor:default}[hidden]{display:none!important}
.video main{padding-top:25px}.video .screen{width:800px;margin-top:15px}.video header{margin:auto;width:800px}
`;

export function demoHtml(scenes: DemoScene[], interactive: boolean, offset = 0, total = scenes.length): string {
  const sections = scenes.map((scene, index) => `
    <section ${index ? 'hidden' : ''}>
      <header><div><h1>${escape(scene.title)}</h1><p>${escape(scene.caption)}</p></div>
      <small>${index + offset + 1} / ${total}</small></header>
      <div class="screen"><img alt="${escape(scene.title)}" src="data:image/jpeg;base64,${scene.screenshot}">
      ${scene.hotspot ? `<button class="marker" type="button" aria-label="Next step" style="left:${scene.hotspot.x}%;top:${scene.hotspot.y}%"${interactive ? '' : ' tabindex="-1"'}></button>` : ''}</div>
    </section>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Product walkthrough</title><style>${styles}</style><body${interactive ? '' : ' class="video"'}><main>${sections}
  ${interactive && scenes.length > 1 ? `<footer><button id="back">Back</button><button id="next">Next</button></footer>
  <script>
    const sections = [...document.querySelectorAll('section')];
    const back = document.querySelector('#back'), next = document.querySelector('#next');
    let index = 0;
    function show(i) {
      index = Math.max(0, Math.min(i, sections.length - 1));
      sections.forEach((section, j) => section.hidden = j !== index);
      back.disabled = index === 0;
      next.disabled = index === sections.length - 1;
    }
    back.onclick = () => show(index - 1);
    next.onclick = () => show(index + 1);
    document.querySelectorAll('.marker').forEach(button => button.onclick = () => { show(index + 1); back.focus(); });
    show(0);
  </script>` : ''}
  </main></body></html>`;
}

export async function renderDemo(scenes: DemoScene[], directory: string, browserChannel?: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const frames = path.join(directory, 'frames');
  await mkdir(frames);
  try {
    const browser = await chromium.launch({ channel: browserChannel, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      for (const [index, scene] of scenes.entries()) {
        await page.setContent(demoHtml([scene], false, index, scenes.length), { waitUntil: 'load' });
        await page.screenshot({ path: path.join(frames, `scene-${index}.png`) });
      }
    } finally {
      await browser.close();
    }

    const manifest = scenes.flatMap((_, index) => [
      `file 'scene-${index}.png'`, `duration ${index === scenes.length - 1 ? 3 : 4}`
    ]);
    manifest.push(`file 'scene-${scenes.length - 1}.png'`);
    await writeFile(path.join(frames, 'frames.txt'), manifest.join('\n'));
    try {
      await run(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'frames.txt',
        '-vf', 'fps=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '../demo.mp4'
      ], { cwd: frames, timeout: 90000, windowsHide: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('FFmpeg is required to export MP4. Install it or set FFMPEG_PATH.');
      }
      throw error;
    }
    await writeFile(path.join(directory, 'demo.html'), demoHtml(scenes, true));
  } finally {
    await rm(frames, { recursive: true, force: true });
  }
}
