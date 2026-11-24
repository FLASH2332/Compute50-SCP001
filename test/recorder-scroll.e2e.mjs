// Run with node --import tsx test/recorder-scroll.e2e.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordWalkthrough } from '../src/demo/recorder.ts';
import { pageIdOf, SectionCrawler } from '../src/sections/sectionCrawler.ts';
import { SectionGraph } from '../src/sections/sectionGraph.ts';

// The absolute position marks let us measure distance and speed from the exported MP4.
// They are part of the page content, so merely moving the cursor cannot pass.
const cases = [
  { name: 'overview', distance: 3200 },
  { name: 'top', distance: 200 },
  { name: 'nested', distance: 900 },
  { name: 'long', distance: 2300 }
];
const server = createServer((req, res) => {
  const test = cases.find(c => '/' + c.name === req.url);
  if (!test) return res.writeHead(404).end();
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Recording test</title><style>
    *{box-sizing:border-box}body{margin:0;color:white;background:#202020;font:24px sans-serif}
    main{position:relative;height:4000px;padding-left:150px}h1,h2{margin:0}
    aside{position:absolute;inset:0 auto 0 0;display:flex}aside i{width:16px;height:100%}
    header,nav{position:fixed;z-index:1;left:0;width:100%;height:32px;background:#111}nav{top:32px}
    section{position:absolute;top:${64 + 24 + test.distance}px;height:${test.name === 'long' ? 1600 : 100}px}
    ${test.name === 'nested' ? 'article{height:100vh;overflow:auto}' : ''}
    </style><header>Menu</header><nav>Topics</nav><article><main><aside aria-hidden="true">${Array.from({ length: 9 }, (_, bit) => {
      const band = 8 * 2 ** bit;
      return `<i style="background:repeating-linear-gradient(#202020 0 ${band}px,#fff ${band}px ${2 * band}px)"></i>`;
    }).join('')}</aside><h1>Overview</h1><section><h2>Destination</h2></section></main></article>`);
});

function measure(file) {
  // Nine vertical strips encode the absolute scroll offset in eight-pixel bands.
  // Read their centers below the navigation bars in each encoded frame.
  const frames = execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-v', 'error', '-i', file, '-vf', 'fps=25,crop=116:2:120:100,scale=9:1:flags=neighbor,format=gray',
    '-f', 'rawvideo', '-'
  ]);
  const offsets = [];
  for (let start = 0; start < frames.length; start += 9) {
    let band = 0;
    for (let bit = 0; bit < 9; bit++) if (frames[start + bit] > 128) band += 2 ** bit;
    offsets.push(band * 8);
  }
  const initial = offsets[0];
  const final = offsets.at(-1);
  const departure = offsets.findIndex(y => y > initial + 8);
  const arrival = offsets.findLastIndex(y => y < final - 8) + 1;
  const travel = final - initial;
  assert.ok(departure >= 0 && arrival > departure + 8, 'MP4 must include intermediate scroll positions');
  const seconds = (arrival - departure + 1) / 25;
  const rest = (offsets.length - arrival) / 25;
  return { travel, seconds, speed: travel / seconds, rest, arrived: arrival / 25, offsets, initial };
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const directory = await mkdtemp(path.join(tmpdir(), 'studio-scroll-test-'));
try {
  for (const test of cases) {
    const url = 'http://127.0.0.1:' + server.address().port + '/' + test.name;
    const crawler = new SectionCrawler({ startUrl: url }, new SectionGraph());
    const page = { id: pageIdOf(url), url, title: 'Recording test' };
    const shots = [{ page }];
    if (test.name === 'overview') Object.assign(shots[0], { overview: true, caption: 'Overview of Recording test' });
    else shots.push({ page, section: { name: 'Destination', role: 'content', regionSelector: 'section' },
      dwell: test.name === 'long' ? 'long' : 'short' });
    const dir = path.join(directory, test.name);
    await recordWalkthrough(shots, crawler, dir, process.env.CRAWLER_BROWSER_CHANNEL);
    const { offsets, initial, ...result } = measure(path.join(dir, 'walkthrough.mp4'));
    console.log(test.name, result);
    const expectedEnd = test.name === 'long' ? 3188 : test.distance;
    assert.ok(Math.abs(result.travel - expectedEnd) < 12, 'Recording should show the whole movement');
    assert.ok(result.rest >= 1, 'Destination should stay in view for at least a second');
    if (test.name === 'overview') {
      assert.ok(offsets.length / 25 <= 12.04);
      assert.match(await readFile(path.join(dir, 'captions.srt'), 'utf8'), /Overview of Recording test/);
    } else {
      const cues = await readFile(path.join(dir, 'captions.srt'), 'utf8');
      const cue = /00:00:(\d\d),(\d{3}) --> [^\n]+\nDestination/.exec(cues);
      assert.ok(cue);
      const start = Number(cue[1]) + Number(cue[2]) / 1000;
      if (test.name === 'long') {
        // Three seconds into the introductory motion the viewport reaches ~60%.
        const departure = offsets.findIndex(y => y > initial + 8) / 25;
        assert.ok(Math.abs(offsets[Math.round((departure + 3) * 25)] - initial - 1920) < 125);
        const midpoint = offsets[Math.round((start + 2.5) * 25)] - initial;
        assert.ok(midpoint > 2400 && midpoint < 3070, 'Travel through the selected section during its dwell');
        assert.ok(Math.abs(result.arrived - start - 5) < 0.6, 'Long dwell takes five seconds');
      } else {
        assert.ok(start >= result.arrived - 0.25, 'Caption should start on arrival');
        assert.ok(result.rest >= 2, 'Hold a selected section for reading');
        assert.ok(Math.max(...offsets) - initial < test.distance + 16, 'No initial skim for a top target or a non-scrolling document');
      }
    }
  }
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}
