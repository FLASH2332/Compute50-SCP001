importScripts('/vendor/cytoscape.min.js');

self.onmessage = ({ data }) => {
  const graph = cytoscape({
    headless: true,
    styleEnabled: true,
    elements: data,
    style: [{ selector: 'node', style: { width: 'data(width)', height: 'data(height)' } }],
    layout: { name: 'preset' }
  });
  graph.layout({ name: 'cose', animate: false, fit: false, idealEdgeLength: 100, nodeOverlap: 20 }).run();
  self.postMessage(graph.nodes().map(n => ({ id: n.id(), position: n.position() })));
  graph.destroy();
};
