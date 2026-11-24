export interface DemoScene {
  title: string;
  caption: string;
  screenshot: string;
  hotspot?: { x: number; y: number };
}const escape = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const styles = `
*{box-sizing:border-box}body{margin:0;background:#101620;color:#f2f4f8;font:16px system-ui,sans-serif}
main{max-width:1136px;margin:auto;padding:24px 32px}header{display:flex;justify-content:space-between;align-items:center;gap:16px}
h1{font-size:24px;margin:0 0 6px}p{margin:0;color:#a7b5c8}small{white-space:nowrap;color:#a7b5c8}
.screen{position:relative;width:min(100%,800px);margin:16px auto 0}.screen img{width:100%;display:block;border-radius:10px;border:1px solid #354256}
.marker{position:absolute;transform:translate(-50%,-50%);width:38px;height:38px;border:3px solid #fff;border-radius:50%;background:#1767e1dd;box-shadow:0 0 0 8px #1767e15c;cursor:pointer}
footer{margin-top:14px;display:flex;justify-content:center;gap:10px}button{border:1px solid #43516a;border-radius:7px;background:#24324a;color:#fff;padding:8px 16px;cursor:pointer}
button:disabled{opacity:.4;cursor:default}[hidden]{display:none!important}
`;

export function demoHtml(scenes: DemoScene[]): string {
  const sections = scenes.map((scene, index) => `
    <section ${index ? 'hidden' : ''}>
      <header><div><h1>${escape(scene.title)}</h1><p>${escape(scene.caption)}</p></div>
      <small>${index + 1} / ${scenes.length}</small></header>
      <div class="screen"><img alt="${escape(scene.title)}" src="data:image/jpeg;base64,${scene.screenshot}">
      ${scene.hotspot ? `<button class="marker" type="button" aria-label="Next step" style="left:${scene.hotspot.x}%;top:${scene.hotspot.y}%"></button>` : ''}</div>
    </section>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Product walkthrough</title><style>${styles}</style><body><main>${sections}
  ${scenes.length > 1 ? `<footer><button id="back">Back</button><button id="next">Next</button></footer>
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


