// Keep long lists usable while retaining access to every recorded item.
function graphList(items, describe) {
  const container = document.createElement('div');
  const list = document.createElement('ul');
  const more = document.createElement('button');
  more.type = 'button';
  container.append(list, more);
  let offset = 0;
  function appendBatch() {
    const fragment = document.createDocumentFragment();
    const end = Math.min(offset + 50, items.length);
    while (offset < end) {
      const entry = document.createElement('li');
      entry.textContent = describe(items[offset++]);
      fragment.append(entry);
    }
    list.append(fragment);
    more.hidden = offset === items.length;
    more.textContent = 'Show ' + Math.min(50, items.length - offset) + ' more';
  }
  more.addEventListener('click', appendBatch);
  appendBatch();
  return container;
}
