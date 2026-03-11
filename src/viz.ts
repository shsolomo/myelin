/**
 * Graph visualization server for myelin.
 *
 * Extracts graph data from SQLite, serves a self-contained D3.js force-layout
 * page on a local HTTP server, and opens the browser automatically.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { KnowledgeGraph, type Node, type Edge } from './memory/graph.js';

// ── Options ──────────────────────────────────────────────────────────────────

export interface VizOptions {
  dbPath?: string;
  db?: string;
  category?: string;
  type?: string;
  minSalience?: number;
  focus?: string;
  depth?: number;
  port?: number;
}

// ── Data extraction ──────────────────────────────────────────────────────────

interface VizNode {
  id: string;
  name: string;
  type: string;
  category: string;
  salience: number;
  description: string;
}

interface VizEdge {
  sourceId: string;
  targetId: string;
  relationship: string;
  weight: number;
}

interface GraphPayload {
  nodes: VizNode[];
  edges: VizEdge[];
  totalNodes: number;
  totalEdges: number;
  avgSalience: number;
}

const MAX_NODES = 500;

function hasColumn(graph: KnowledgeGraph, table: string, col: string): boolean {
  const rows = graph.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((r) => r.name === col);
}

function extractGraph(
  graph: KnowledgeGraph,
  opts: { category?: string; type?: string; minSalience?: number; focus?: string; depth?: number },
): GraphPayload {
  const stats = graph.stats();
  const hasCat = hasColumn(graph, 'nodes', 'category');

  let nodes: Node[];
  let edges: Edge[];

  if (opts.focus) {
    // BFS from focus node
    const focusNodes = graph.searchNodes(opts.focus, 5);
    const seed = focusNodes[0];
    if (!seed) {
      return { nodes: [], edges: [], totalNodes: stats.nodeCount, totalEdges: stats.edgeCount, avgSalience: stats.avgSalience };
    }

    const visited = new Set<string>([seed.id]);
    const queue: Array<{ id: string; d: number }> = [{ id: seed.id, d: 0 }];
    const maxDepth = opts.depth ?? 2;
    const collectedNodes: Node[] = [seed];

    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if (d >= maxDepth) continue;

      const neighborEdges = graph.getEdges(id, 'both');
      for (const e of neighborEdges) {
        const neighborId = e.sourceId === id ? e.targetId : e.sourceId;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          const neighbor = graph.getNode(neighborId);
          if (neighbor) {
            collectedNodes.push(neighbor);
            queue.push({ id: neighborId, d: d + 1 });
          }
        }
      }
    }

    nodes = collectedNodes;
    // Collect edges between collected nodes
    const nodeIds = new Set(nodes.map((n) => n.id));
    edges = [];
    for (const nid of nodeIds) {
      for (const e of graph.getEdges(nid, 'outgoing')) {
        if (nodeIds.has(e.targetId)) edges.push(e);
      }
    }
  } else {
    // Bulk query — use direct SQL for performance
    let query = 'SELECT * FROM nodes WHERE salience >= ?';
    const params: unknown[] = [opts.minSalience ?? 0];

    if (opts.type) {
      // Support comma-separated types for multi-select checkbox filtering
      const types = opts.type.split(',').map((t) => t.trim()).filter(Boolean);
      if (types.length === 1) {
        query += ' AND type = ?';
        params.push(types[0]);
      } else if (types.length > 1) {
        query += ` AND type IN (${types.map(() => '?').join(',')})`;
        params.push(...types);
      }
    }
    if (opts.category && hasCat) {
      query += ' AND category = ?';
      params.push(opts.category);
    }

    query += ' ORDER BY salience DESC LIMIT ?';
    params.push(MAX_NODES);

    const nodeRows = graph.db.prepare(query).all(...params) as Array<{
      id: string; type: string; name: string; description: string;
      salience: number; category?: string;
    }>;

    nodes = nodeRows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      description: r.description,
      salience: r.salience,
      confidence: 1,
      sourceAgent: '',
      createdAt: '',
      lastReinforced: '',
      tags: [],
      category: r.category,
    }));

    // Collect edges between visible nodes
    const nodeIds = new Set(nodes.map((n) => n.id));
    const placeholders = [...nodeIds].map(() => '?').join(',');
    const edgeRows = nodeIds.size > 0
      ? graph.db.prepare(
          `SELECT * FROM edges WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})`,
        ).all(...nodeIds, ...nodeIds) as Array<{
          source_id: string; target_id: string; relationship: string; weight: number;
        }>
      : [];

    edges = edgeRows.map((r) => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      relationship: r.relationship,
      weight: r.weight,
      description: '',
      sourceAgent: '',
      createdAt: '',
      lastReinforced: '',
    }));
  }

  const vizNodes: VizNode[] = nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    category: n.category ?? 'knowledge',
    salience: n.salience,
    description: (n.description || '').slice(0, 100),
  }));

  const vizEdges: VizEdge[] = edges.map((e) => ({
    sourceId: e.sourceId,
    targetId: e.targetId,
    relationship: e.relationship,
    weight: e.weight,
  }));

  return {
    nodes: vizNodes,
    edges: vizEdges,
    totalNodes: stats.nodeCount,
    totalEdges: stats.edgeCount,
    avgSalience: stats.avgSalience,
  };
}

// ── HTML template ────────────────────────────────────────────────────────────

function getHtmlPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Myelin — Knowledge Graph</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    overflow: hidden;
    height: 100vh;
    width: 100vw;
  }

  svg { display: block; width: 100%; height: 100%; }

  /* ── Controls panel ─────────────────────────────────────── */
  #controls {
    position: fixed; top: 16px; left: 16px;
    background: rgba(22, 22, 46, 0.92);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 16px 18px;
    z-index: 10;
    min-width: 220px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  #controls h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: #888;
    margin-bottom: 10px;
  }
  #controls label {
    display: block;
    font-size: 12px;
    color: #aaa;
    margin-top: 8px;
    margin-bottom: 3px;
  }
  #controls select, #controls input[type="text"] {
    width: 100%;
    padding: 5px 8px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 13px;
    outline: none;
  }
  #controls select:focus, #controls input:focus {
    border-color: rgba(116, 185, 255, 0.5);
  }
  #controls input[type="range"] {
    width: 100%;
    margin-top: 4px;
    accent-color: #74b9ff;
  }
  .range-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .range-row input { flex: 1; }
  .range-val {
    font-size: 12px;
    color: #74b9ff;
    min-width: 30px;
    text-align: right;
  }
  #node-count {
    margin-top: 12px;
    font-size: 12px;
    color: #666;
    text-align: center;
  }

  /* ── Stats panel ────────────────────────────────────────── */
  #stats {
    position: fixed; top: 16px; right: 16px;
    background: rgba(22, 22, 46, 0.92);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 14px 18px;
    z-index: 10;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    text-align: right;
  }
  #stats .stat-row {
    font-size: 12px; color: #888; margin-bottom: 4px;
  }
  #stats .stat-val {
    font-size: 16px; font-weight: 600; color: #e0e0e0;
  }

  /* ── Legend ──────────────────────────────────────────────── */
  #legend {
    position: fixed; bottom: 16px; right: 16px;
    background: rgba(22, 22, 46, 0.92);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 14px 18px;
    z-index: 10;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    max-height: 280px;
    overflow-y: auto;
  }
  #legend h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: #888;
    margin-bottom: 8px;
  }
  .legend-item {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: #bbb; margin-bottom: 4px;
  }
  .legend-dot {
    width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  }

  /* ── Tooltip ────────────────────────────────────────────── */
  #tooltip {
    position: fixed;
    pointer-events: none;
    background: rgba(10, 10, 30, 0.95);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 12px;
    color: #ddd;
    max-width: 280px;
    z-index: 100;
    opacity: 0;
    transition: opacity 0.15s;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }
  #tooltip .tt-name { font-weight: 600; font-size: 14px; color: #fff; }
  #tooltip .tt-type { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  #tooltip .tt-sal { color: #74b9ff; margin-top: 4px; }
  #tooltip .tt-desc { color: #aaa; margin-top: 4px; line-height: 1.4; }

  /* ── Title ──────────────────────────────────────────────── */
  #title {
    position: fixed; bottom: 16px; left: 16px;
    font-size: 13px; color: #444; z-index: 10;
    font-weight: 300; letter-spacing: 0.5px;
  }
  #title span { color: #74b9ff; font-weight: 600; }
.checkbox-group {
  display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;
}
.checkbox-group label {
  display: flex; align-items: center; gap: 3px;
  font-size: 11px; cursor: pointer; padding: 2px 6px;
  border-radius: 4px; border: 1px solid #444;
  transition: background 0.15s;
}
.checkbox-group label:hover { background: #333; }
.checkbox-group input[type="checkbox"] { margin: 0; cursor: pointer; }
.checkbox-group .type-dot {
  width: 8px; height: 8px; border-radius: 50%; display: inline-block;
}
</style>
</head>
<body>

<div id="controls">
  <h3>Filters</h3>
  <label for="f-category">Category</label>
  <select id="f-category">
    <option value="">All</option>
    <option value="knowledge">Knowledge</option>
    <option value="code">Code</option>
  </select>
  <label for="f-type">Type</label>
  <div id="f-type-checkboxes" class="checkbox-group"></div>

  <label for="f-salience">Min Salience</label>
  <div class="range-row">
    <input type="range" id="f-salience" min="0" max="1" step="0.05" value="0">
    <span class="range-val" id="sal-val">0.00</span>
  </div>
  <label for="f-search">Search</label>
  <input type="text" id="f-search" placeholder="Node name…">
  <div id="node-count"></div>
</div>

<div id="stats"></div>
<div id="legend"></div>
<div id="tooltip"></div>
<div id="title"><span>myelin</span> knowledge graph</div>

<svg id="graph"></svg>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
(function() {
  // ── Color map ──────────────────────────────────────────────
  const TYPE_COLORS = {
    person:      '#4ecdc4',
    decision:    '#ff6b6b',
    pattern:     '#ffd93d',
    bug:         '#ff4757',
    tool:        '#a29bfe',
    initiative:  '#6c5ce7',
    concept:     '#74b9ff',
    meeting:     '#55efc4',
    rule:        '#fd79a8',
    convention:  '#fdcb6e',
    Class:       '#00b894',
    Method:      '#0984e3',
    Function:    '#0984e3',
    Interface:   '#e17055',
  };
  const DEFAULT_COLOR = '#636e72';

  function nodeColor(type) {
    return TYPE_COLORS[type] || DEFAULT_COLOR;
  }

  function nodeRadius(salience) {
    return 4 + salience * 16;
  }

  function truncate(s, n) {
    return s && s.length > n ? s.slice(0, n) + '…' : s;
  }

  // ── State ──────────────────────────────────────────────────
  let graphData = { nodes: [], edges: [], totalNodes: 0, totalEdges: 0, avgSalience: 0 };
  let simulation, svg, g, linkGroup, nodeGroup, labelGroup;
  let highlightedId = null;
  let currentZoom = 1;

  // ── SVG setup ──────────────────────────────────────────────
  svg = d3.select('#graph');
  const defs = svg.append('defs');

  // Arrow marker
  defs.append('marker')
    .attr('id', 'arrowhead')
    .attr('viewBox', '0 -4 8 8')
    .attr('refX', 20)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-3L7,0L0,3')
    .attr('fill', 'rgba(255,255,255,0.15)');

  // Glow filter for highlighted nodes
  const glow = defs.append('filter').attr('id', 'glow');
  glow.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur');
  const merge = glow.append('feMerge');
  merge.append('feMergeNode').attr('in', 'blur');
  merge.append('feMergeNode').attr('in', 'SourceGraphic');

  g = svg.append('g');
  linkGroup = g.append('g').attr('class', 'links');
  nodeGroup = g.append('g').attr('class', 'nodes');
  labelGroup = g.append('g').attr('class', 'labels');

  // Zoom & pan
  const zoom = d3.zoom()
    .scaleExtent([0.1, 8])
    .on('zoom', (e) => {
      g.attr('transform', e.transform);
      currentZoom = e.transform.k;
      updateLabelVisibility();
    });
  svg.call(zoom);

  // ── Tooltip ────────────────────────────────────────────────
  const tooltip = d3.select('#tooltip');

  function showTooltip(event, d) {
    tooltip
      .style('opacity', 1)
      .style('left', (event.clientX + 14) + 'px')
      .style('top', (event.clientY - 10) + 'px')
      .html(
        '<div class="tt-name">' + d.name + '</div>' +
        '<div class="tt-type">' + d.type + (d.category ? ' · ' + d.category : '') + '</div>' +
        '<div class="tt-sal">Salience: ' + d.salience.toFixed(2) + '</div>' +
        (d.description ? '<div class="tt-desc">' + d.description + '</div>' : '')
      );
  }

  function hideTooltip() {
    tooltip.style('opacity', 0);
  }

  // ── Rendering ──────────────────────────────────────────────
  function render(data) {
    graphData = data;
    const { nodes, edges } = data;

    // Build edge index for highlights
    const linked = new Set();
    edges.forEach(e => {
      linked.add(e.sourceId + '|' + e.targetId);
      linked.add(e.targetId + '|' + e.sourceId);
    });

    // D3 needs source/target as ids for the force
    const links = edges.map(e => ({
      source: e.sourceId,
      target: e.targetId,
      relationship: e.relationship,
      weight: e.weight,
    }));

    // Stop old simulation
    if (simulation) simulation.stop();

    // ── Links ──
    linkGroup.selectAll('line').remove();
    const link = linkGroup.selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'rgba(255,255,255,0.12)')
      .attr('stroke-width', d => 0.5 + d.weight * 1.0)
      .attr('stroke-opacity', d => 0.1 + d.weight * 0.3)
      .attr('marker-end', 'url(#arrowhead)');

    // ── Nodes ──
    nodeGroup.selectAll('circle').remove();
    const node = nodeGroup.selectAll('circle')
      .data(nodes, d => d.id)
      .join('circle')
      .attr('r', d => nodeRadius(d.salience))
      .attr('fill', d => nodeColor(d.type))
      .attr('stroke', d => d3.color(nodeColor(d.type)).brighter(0.8))
      .attr('stroke-width', 0.5)
      .attr('cursor', 'pointer')
      .on('mouseover', function(event, d) {
        d3.select(this).attr('filter', 'url(#glow)');
        showTooltip(event, d);
      })
      .on('mousemove', (event, d) => showTooltip(event, d))
      .on('mouseout', function() {
        d3.select(this).attr('filter', null);
        hideTooltip();
      })
      .on('click', function(event, d) {
        event.stopPropagation();
        if (highlightedId === d.id) {
          highlightedId = null;
          resetHighlight();
        } else {
          highlightedId = d.id;
          applyHighlight(d.id, linked);
        }
      })
      .call(d3.drag()
        .on('start', dragStarted)
        .on('drag', dragged)
        .on('end', dragEnded));

    // ── Labels ──
    labelGroup.selectAll('text').remove();
    const label = labelGroup.selectAll('text')
      .data(nodes, d => d.id)
      .join('text')
      .text(d => truncate(d.name, 20))
      .attr('font-size', '10px')
      .attr('fill', '#ccc')
      .attr('text-anchor', 'middle')
      .attr('dy', d => -(nodeRadius(d.salience) + 4))
      .attr('pointer-events', 'none')
      .attr('opacity', d => d.salience > 0.5 ? 0.9 : 0);

    // Double-click to reset
    svg.on('dblclick.reset', () => {
      highlightedId = null;
      resetHighlight();
    });

    // ── Simulation ──
    const w = window.innerWidth;
    const h = window.innerHeight;

    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(d => 60 + (1 - d.weight) * 80).strength(d => 0.3 + d.weight * 0.4))
      .force('charge', d3.forceManyBody().strength(d => -80 - d.salience * 120))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('collision', d3.forceCollide().radius(d => nodeRadius(d.salience) + 2))
      .force('x', d3.forceX(w / 2).strength(0.03))
      .force('y', d3.forceY(h / 2).strength(0.03))
      .alphaDecay(0.02)
      .on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        node
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);
        label
          .attr('x', d => d.x)
          .attr('y', d => d.y);
      });

    // UI updates
    updateStats(data);
    updateLegend(nodes);
    updateNodeCount(nodes.length, data.totalNodes);
    populateTypeFilter(nodes);
  }

  // ── Highlight ──────────────────────────────────────────────
  function applyHighlight(nodeId, linked) {
    nodeGroup.selectAll('circle')
      .attr('opacity', d => {
        if (d.id === nodeId) return 1;
        if (linked.has(nodeId + '|' + d.id)) return 1;
        return 0.08;
      });
    linkGroup.selectAll('line')
      .attr('stroke-opacity', d => {
        if (d.source.id === nodeId || d.target.id === nodeId) return 0.6;
        return 0.02;
      });
    labelGroup.selectAll('text')
      .attr('opacity', d => {
        if (d.id === nodeId) return 1;
        if (linked.has(nodeId + '|' + d.id)) return 0.9;
        return 0;
      });
  }

  function resetHighlight() {
    nodeGroup.selectAll('circle').attr('opacity', 1);
    linkGroup.selectAll('line').attr('stroke-opacity', d => 0.1 + d.weight * 0.3);
    updateLabelVisibility();
  }

  function updateLabelVisibility() {
    labelGroup.selectAll('text')
      .attr('opacity', d => {
        if (highlightedId) return 0;
        if (currentZoom > 2) return 0.9;
        if (d.salience > 0.5) return 0.9;
        if (currentZoom > 1.2) return d.salience > 0.3 ? 0.7 : 0;
        return 0;
      });
  }

  // ── Search highlight ───────────────────────────────────────
  function applySearch(query) {
    if (!query) {
      nodeGroup.selectAll('circle').attr('stroke-width', 0.5).attr('stroke', d => d3.color(nodeColor(d.type)).brighter(0.8));
      labelGroup.selectAll('text').attr('fill', '#ccc');
      return;
    }
    const q = query.toLowerCase();
    nodeGroup.selectAll('circle')
      .attr('stroke-width', d => d.name.toLowerCase().includes(q) ? 3 : 0.5)
      .attr('stroke', d => d.name.toLowerCase().includes(q) ? '#fff' : d3.color(nodeColor(d.type)).brighter(0.8));
    labelGroup.selectAll('text')
      .attr('opacity', d => d.name.toLowerCase().includes(q) ? 1 : 0)
      .attr('fill', d => d.name.toLowerCase().includes(q) ? '#fff' : '#ccc');
  }

  // ── Drag handlers ──────────────────────────────────────────
  function dragStarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x; d.fy = event.y;
  }
  function dragEnded(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null; d.fy = null;
  }

  // ── UI updates ─────────────────────────────────────────────
  function updateStats(data) {
    document.getElementById('stats').innerHTML =
      '<div class="stat-row">Nodes <div class="stat-val">' + data.nodes.length + '</div></div>' +
      '<div class="stat-row">Edges <div class="stat-val">' + data.edges.length + '</div></div>' +
      '<div class="stat-row">Avg Salience <div class="stat-val">' + data.avgSalience.toFixed(2) + '</div></div>';
  }

  function updateLegend(nodes) {
    const types = {};
    nodes.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
    const sorted = Object.entries(types).sort((a,b) => b[1] - a[1]);

    let html = '<h3>Types</h3>';
    sorted.forEach(([type, count]) => {
      html += '<div class="legend-item"><span class="legend-dot" style="background:' +
        nodeColor(type) + '"></span>' + type + ' (' + count + ')</div>';
    });
    document.getElementById('legend').innerHTML = html;
  }

  function updateNodeCount(shown, total) {
    document.getElementById('node-count').textContent = 'Showing ' + shown + ' of ' + total + ' nodes';
  }

  let knownTypes = new Set();
  function populateTypeFilter(nodes) {
    const types = new Set(nodes.map(n => n.type));
    if (setsEqual(types, knownTypes)) return;
    knownTypes = types;

    const container = document.getElementById('f-type-checkboxes');
    // Preserve currently unchecked types across refreshes
    const unchecked = new Set(
      [...container.querySelectorAll('input:not(:checked)')].map(cb => cb.value)
    );
    container.innerHTML = '';
    [...types].sort().forEach(t => {
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = t;
      cb.checked = !unchecked.has(t);
      cb.addEventListener('change', fetchGraph);
      const dot = document.createElement('span');
      dot.className = 'type-dot';
      dot.style.background = TYPE_COLORS[t] || DEFAULT_COLOR;
      lbl.appendChild(cb);
      lbl.appendChild(dot);
      lbl.appendChild(document.createTextNode(' ' + t));
      container.appendChild(lbl);
    });
  }

  function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  // ── Fetch & filter ─────────────────────────────────────────
  async function fetchGraph() {
    const params = new URLSearchParams();
    const cat = document.getElementById('f-category').value;
    const checkedTypes = [...document.querySelectorAll('#f-type-checkboxes input:checked')].map(cb => cb.value);
    const allTypes = [...document.querySelectorAll('#f-type-checkboxes input')].length;
    const type = (checkedTypes.length > 0 && checkedTypes.length < allTypes) ? checkedTypes.join(',') : '';
    const sal = document.getElementById('f-salience').value;

    if (cat) params.set('category', cat);
    if (type) params.set('type', type);
    if (parseFloat(sal) > 0) params.set('minSalience', sal);

    const url = '/api/graph' + (params.toString() ? '?' + params.toString() : '');
    const resp = await fetch(url);
    const data = await resp.json();
    render(data);
  }

  // ── Event listeners ────────────────────────────────────────
  document.getElementById('f-category').addEventListener('change', fetchGraph);
  // type checkboxes have inline event listeners

  let salTimer = null;
  document.getElementById('f-salience').addEventListener('input', function() {
    document.getElementById('sal-val').textContent = parseFloat(this.value).toFixed(2);
    clearTimeout(salTimer);
    salTimer = setTimeout(fetchGraph, 300);
  });

  let searchTimer = null;
  document.getElementById('f-search').addEventListener('input', function() {
    clearTimeout(searchTimer);
    const q = this.value;
    searchTimer = setTimeout(() => applySearch(q), 150);
  });

  // ── Initial load ───────────────────────────────────────────
  fetchGraph();
})();
</script>
</body>
</html>`;
}

// ── HTTP server ──────────────────────────────────────────────────────────────

function findFreePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(start, () => {
      server.close(() => resolve(start));
    });
    server.on('error', () => {
      resolve(findFreePort(start + 1));
    });
  });
}

function openBrowser(url: string): void {
  try {
    const os = platform();
    if (os === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore' });
    } else if (os === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  } catch {
    // Silently fail — user can manually open the URL
  }
}

export async function startVizServer(options: VizOptions): Promise<void> {
  const dbPath = options.dbPath || options.db || (await import('node:path')).join((await import('node:os')).homedir(), '.copilot', '.working-memory', 'graph.db');
  const graph = new KnowledgeGraph(dbPath);

  // Ensure code-graph columns exist
  try { graph.extendForCode(); } catch { /* already extended or not needed */ }

  const html = getHtmlPage();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost`);

    if (url.pathname === '/api/graph') {
      const queryCategory = url.searchParams.get('category') || options.category;
      const queryType = url.searchParams.get('type') || options.type;
      const queryMinSalience = url.searchParams.has('minSalience')
        ? parseFloat(url.searchParams.get('minSalience')!)
        : options.minSalience;

      const payload = extractGraph(graph, {
        category: queryCategory || undefined,
        type: queryType || undefined,
        minSalience: queryMinSalience,
        focus: options.focus,
        depth: options.depth,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  const port = await findFreePort(options.port || 3000);
  const url = `http://localhost:${port}`;

  server.listen(port, () => {
    console.log(`\n  🧠 Myelin graph visualization\n`);
    console.log(`  ${url}\n`);
    console.log(`  Press Ctrl+C to stop\n`);
    openBrowser(url);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n  Shutting down…');
    graph.close();
    server.close(() => process.exit(0));
  });

  // Keep the process alive
  await new Promise(() => {});
}
