#!/usr/bin/env node

// Suppress model loading progress bars
process.env.TRANSFORMERS_NO_ADVISORY_WARNINGS = '1';
process.env.HF_HUB_DISABLE_PROGRESS_BARS = '1';

import { program } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';

import { KnowledgeGraph, NodeType, RelationshipType } from './memory/graph.js';
import { initSchema, extendSchemaForCode } from './memory/schema.js';
import {
  getBootContext,
  generatePersonaDiff,
  appendStructuredLog,
  getAgentLogInstructions,
} from './memory/agents.js';
import { nremReplay, remRefine } from './memory/replay.js';
import { parseLogFile } from './memory/log-parser.js';
import { readLogEntries, logFilePath } from './memory/structured-log.js';
import { getEmbedding, embedAllNodes } from './memory/embeddings.js';
import { parseLlmExtraction, loadExtractionToGraph } from './memory/extractors.js';
import { scoreEntry } from './memory/salience.js';
import { getLlmExtractionPrompt } from './memory/vocabulary.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DB = join(homedir(), '.copilot', '.working-memory', 'graph.db');
const DEFAULT_LOG = join(homedir(), '.copilot', '.working-memory', 'agents', 'donna', 'log.md');
const VALID_LOG_TYPES = ['decision', 'action', 'finding', 'error', 'handover', 'observation'] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveDbPath(db?: string): string {
  return db ?? DEFAULT_DB;
}

function openGraph(db?: string): KnowledgeGraph {
  const dbPath = resolveDbPath(db);
  mkdirSync(dirname(dbPath), { recursive: true });
  return new KnowledgeGraph(dbPath);
}

function openDb(dbOpt?: string): Database.Database {
  const dbPath = resolveDbPath(dbOpt);
  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Database not found: ${dbPath}`));
    process.exit(1);
  }
  return new Database(dbPath);
}

function getColumns(db: Database.Database): Set<string> {
  const rows = db.pragma('table_info(nodes)') as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function resolveLogPath(agent: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const jsonlPath = logFilePath(agent);
  if (existsSync(jsonlPath)) return jsonlPath;
  const mdPath = join(homedir(), '.copilot', '.working-memory', 'agents', agent, 'log.md');
  if (existsSync(mdPath)) return mdPath;
  return null;
}

function salienceColor(sal: number): string {
  if (sal >= 0.7) return chalk.green(sal.toFixed(2));
  if (sal >= 0.4) return chalk.yellow(sal.toFixed(2));
  return chalk.dim(sal.toFixed(2));
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// ── Program ──────────────────────────────────────────────────────────────────

program
  .name('myelin')
  .description('Knowledge graph memory system — semantic search, NER extraction, brain-inspired consolidation.')
  .version('0.1.0');

// ── Graph commands ───────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize graph.db with schema')
  .option('--db <path>', 'Path to graph database')
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    initSchema(db);
    extendSchemaForCode(db);
    db.close();
    console.log(`${chalk.green('✅')} Initialized graph at ${dbPath}`);
    process.exit(0);
  });

program
  .command('stats')
  .description('Show node/edge counts by type')
  .option('-c, --category <cat>', 'Filter by category (code, knowledge)')
  .option('--db <path>', 'Path to graph.db')
  .action((opts) => {
    const db = openDb(opts.db);
    const cols = getColumns(db);
    const hasCategory = cols.has('category');

    // Node stats
    console.log(chalk.bold('\nNode Statistics'));
    const nodeTable = new Table({
      head: ['Category', 'Type', 'Count'],
    });

    let nodeRows: Array<{ cat: string; type: string; cnt: number }>;
    if (hasCategory) {
      let query = "SELECT COALESCE(category, 'unknown') as cat, type, COUNT(*) as cnt FROM nodes";
      const params: unknown[] = [];
      if (opts.category) {
        query += ' WHERE category = ?';
        params.push(opts.category);
      }
      query += ' GROUP BY cat, type ORDER BY cat, cnt DESC';
      nodeRows = db.prepare(query).all(...params) as typeof nodeRows;
    } else {
      const raw = db.prepare(
        "SELECT 'all' as cat, type, COUNT(*) as cnt FROM nodes GROUP BY type ORDER BY cnt DESC",
      ).all() as typeof nodeRows;
      nodeRows = raw;
    }

    for (const row of nodeRows) {
      nodeTable.push([chalk.cyan(row.cat), chalk.green(row.type), String(row.cnt)]);
    }
    console.log(nodeTable.toString());

    // Edge stats
    console.log(chalk.bold('\nEdge Statistics'));
    const edgeTable = new Table({
      head: ['Relationship', 'Count'],
    });
    const edgeRows = db.prepare(
      'SELECT relationship, COUNT(*) as cnt FROM edges GROUP BY relationship ORDER BY cnt DESC',
    ).all() as Array<{ relationship: string; cnt: number }>;
    for (const row of edgeRows) {
      edgeTable.push([chalk.cyan(row.relationship), String(row.cnt)]);
    }
    console.log(edgeTable.toString());

    // Totals
    const totalNodes = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    const totalEdges = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
    console.log(`\nTotal: ${totalNodes.toLocaleString()} nodes, ${totalEdges.toLocaleString()} edges`);
    db.close();
    process.exit(0);
  });

program
  .command('types')
  .description('List all node types with counts grouped by category')
  .option('--db <path>', 'Path to graph.db')
  .action((opts) => {
    const db = openDb(opts.db);
    const cols = getColumns(db);
    const hasCategory = cols.has('category');

    console.log(chalk.bold('\nNode Types'));
    const table = new Table({
      head: ['Category', 'Type', 'Count'],
    });

    let rows: Array<{ cat: string; type: string; cnt: number }>;
    if (hasCategory) {
      rows = db.prepare(
        "SELECT COALESCE(category, 'unknown') as cat, type, COUNT(*) as cnt FROM nodes GROUP BY cat, type ORDER BY cat, cnt DESC",
      ).all() as typeof rows;
    } else {
      rows = db.prepare(
        "SELECT 'all' as cat, type, COUNT(*) as cnt FROM nodes GROUP BY type ORDER BY cnt DESC",
      ).all() as typeof rows;
    }

    for (const row of rows) {
      table.push([chalk.cyan(row.cat), chalk.green(row.type), String(row.cnt)]);
    }
    console.log(table.toString());
    db.close();
    process.exit(0);
  });

program
  .command('nodes')
  .description('List nodes with filters')
  .option('-c, --category <cat>', 'Filter by category (code, knowledge)')
  .option('-t, --type <type>', 'Filter by node type')
  .option('-f, --file <path>', 'Filter by file path (substring match)')
  .option('-a, --agent <name>', 'Filter by source agent')
  .option('--tag <tag>', 'Filter by domain tag')
  .option('-s, --min-salience <n>', 'Minimum salience', '0')
  .option('-n, --limit <n>', 'Max results', '50')
  .option('--db <path>', 'Path to graph.db')
  .action((opts) => {
    const db = openDb(opts.db);
    const cols = getColumns(db);
    const hasCategory = cols.has('category');
    const hasFilePath = cols.has('file_path');

    let query = 'SELECT DISTINCT n.* FROM nodes n';
    const joins: string[] = [];
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.tag) {
      joins.push('JOIN node_tags nt ON n.id = nt.node_id');
      conditions.push('nt.tag = ?');
      params.push(opts.tag);
    }
    if (opts.category && hasCategory) {
      conditions.push('n.category = ?');
      params.push(opts.category);
    }
    if (opts.type) {
      conditions.push('LOWER(n.type) = LOWER(?)');
      params.push(opts.type);
    }
    if (opts.file && hasFilePath) {
      conditions.push('n.file_path LIKE ?');
      params.push(`%${opts.file}%`);
    }
    if (opts.agent) {
      conditions.push('n.source_agent = ?');
      params.push(opts.agent);
    }
    conditions.push('n.salience >= ?');
    params.push(parseFloat(opts.minSalience));

    if (joins.length) query += ' ' + joins.join(' ');
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY n.salience DESC LIMIT ?';
    params.push(parseInt(opts.limit));

    const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

    if (!rows.length) {
      console.log(chalk.yellow('No nodes found matching filters.'));
      db.close();
      process.exit(0);
    }

    console.log(chalk.bold(`\nNodes (${rows.length} shown)`));
    const head = ['Type', 'Name'];
    if (hasFilePath) head.push('File');
    head.push('Salience');
    if (hasCategory) head.push('Category');
    const table = new Table({ head });

    for (const row of rows) {
      const sal = row.salience as number;
      const cells: string[] = [
        chalk.cyan(row.type as string),
        chalk.bold(row.name as string),
      ];
      if (hasFilePath) cells.push(chalk.dim(((row.file_path as string) || '').slice(0, 50)));
      cells.push(salienceColor(sal));
      if (hasCategory) cells.push(chalk.dim((row.category as string) || ''));
      table.push(cells);
    }
    console.log(table.toString());
    db.close();
    process.exit(0);
  });

program
  .command('show')
  .description('Show a node and its connected edges')
  .argument('<name>', 'Name or partial name to search for')
  .option('--db <path>', 'Path to graph.db')
  .action((name: string, opts) => {
    const db = openDb(opts.db);
    const cols = getColumns(db);
    const hasFilePath = cols.has('file_path');
    const hasCategory = cols.has('category');
    const hasLineStart = cols.has('line_start');
    const hasLineEnd = cols.has('line_end');

    const rows = db.prepare(
      'SELECT * FROM nodes WHERE name LIKE ? ORDER BY salience DESC LIMIT 10',
    ).all(`%${name}%`) as Array<Record<string, unknown>>;

    if (!rows.length) {
      console.log(chalk.yellow(`No nodes found matching '${name}'`));
      db.close();
      process.exit(0);
    }

    for (const row of rows) {
      console.log(`\n${chalk.bold.cyan(row.name as string)}`);
      console.log(`  Type: ${row.type}`);
      if (hasCategory && row.category) {
        console.log(`  Category: ${row.category}`);
      }
      console.log(`  Salience: ${(row.salience as number).toFixed(2)}`);

      if (hasFilePath && row.file_path) {
        let lineInfo = '';
        if (hasLineStart && row.line_start) {
          lineInfo = `:${row.line_start}`;
          if (hasLineEnd && row.line_end) {
            lineInfo += `-${row.line_end}`;
          }
        }
        console.log(`  File: ${row.file_path}${lineInfo}`);
      }

      if (row.description) {
        console.log(`  Description: ${row.description}`);
      }

      // Tags
      const tags = db.prepare(
        'SELECT tag FROM node_tags WHERE node_id = ?',
      ).all(row.id as string) as Array<{ tag: string }>;
      if (tags.length) {
        console.log(`  Tags: ${tags.map((t) => t.tag).join(', ')}`);
      }

      // Outgoing edges
      const outEdges = db.prepare(
        'SELECT e.target_id, e.relationship, n.name as target_name FROM edges e LEFT JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?',
      ).all(row.id as string) as Array<{ target_id: string; relationship: string; target_name: string | null }>;
      if (outEdges.length) {
        console.log(`  ${chalk.green('Outgoing:')}`);
        for (const e of outEdges) {
          const label = e.target_name || e.target_id;
          console.log(`    --${e.relationship}--> ${label}`);
        }
      }

      // Incoming edges
      const inEdges = db.prepare(
        'SELECT e.source_id, e.relationship, n.name as source_name FROM edges e LEFT JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?',
      ).all(row.id as string) as Array<{ source_id: string; relationship: string; source_name: string | null }>;
      if (inEdges.length) {
        console.log(`  ${chalk.blue('Incoming:')}`);
        for (const e of inEdges) {
          const label = e.source_name || e.source_id;
          console.log(`    <--${e.relationship}-- ${label}`);
        }
      }
    }

    db.close();
    process.exit(0);
  });

program
  .command('add-node')
  .description('Add a node to the graph manually')
  .requiredOption('--name <name>', 'Node display name')
  .option('-t, --type <type>', 'Node type', 'concept')
  .option('-d, --desc <text>', 'Description', '')
  .option('-s, --salience <n>', 'Salience score', '0.5')
  .option('-a, --agent <name>', 'Source agent', 'manual')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--db <path>', 'Path to graph.db')
  .action((opts) => {
    const graph = openGraph(opts.db);
    const node = graph.addNode({
      type: opts.type as NodeType,
      name: opts.name,
      description: opts.desc,
      salience: parseFloat(opts.salience),
      sourceAgent: opts.agent,
      tags: opts.tags ? opts.tags.split(',').map((t: string) => t.trim()) : [],
    });
    console.log(`Added node: ${node.id} (${node.type}: ${node.name})`);
    graph.close();
    process.exit(0);
  });

program
  .command('query')
  .description('Search across all nodes by text (semantic or FTS5)')
  .argument('<text>', 'Search text')
  .option('-n, --limit <n>', 'Max results', '20')
  .option('--no-semantic', 'Disable semantic search (use FTS5 instead)')
  .option('--db <path>', 'Path to graph.db')
  .action(async (text: string, opts) => {
    const graph = openGraph(opts.db);
    const limit = parseInt(opts.limit);

    // Try semantic search first if enabled
    if (opts.semantic !== false) {
      try {
        const queryVec = await getEmbedding(text);
        if (queryVec && queryVec.length > 0) {
          const results = graph.semanticSearch(queryVec, limit);
          if (results.length) {
            console.log(chalk.bold(`\nSemantic search: '${text}'`));
            const table = new Table({
              head: ['Type', 'Name', 'Distance', 'Salience', 'Description'],
            });
            for (const { node, distance } of results) {
              table.push([
                chalk.cyan(node.type),
                chalk.bold(node.name),
                distance.toFixed(4),
                salienceColor(node.salience),
                (node.description || '').slice(0, 50),
              ]);
            }
            console.log(table.toString());
            console.log(chalk.dim('Mode: semantic (sqlite-vec)'));
            graph.close();
            process.exit(0);
          }
        }
      } catch {
        // Fall through to FTS5
      }
    }

    // FTS5 fallback
    const nodes = graph.searchNodes(text, limit);
    if (!nodes.length) {
      console.log(`No nodes matching '${text}'`);
      graph.close();
      process.exit(0);
    }

    console.log(chalk.bold(`\nSearch: '${text}'`));
    const table = new Table({
      head: ['Type', 'Name', 'Salience', 'Description'],
    });
    for (const n of nodes) {
      table.push([
        chalk.cyan(n.type),
        chalk.bold(n.name),
        salienceColor(n.salience),
        (n.description || '').slice(0, 50),
      ]);
    }
    console.log(table.toString());
    console.log(chalk.dim('Mode: full-text (FTS5)'));
    graph.close();
    process.exit(0);
  });

// ── Embedding command ────────────────────────────────────────────────────────

program
  .command('embed')
  .description('Batch embed nodes for semantic search')
  .option('-c, --category <cat>', 'Filter by category (knowledge, code)')
  .option('-f, --force', 'Re-embed even if already embedded')
  .option('-s, --stats', 'Show embedding coverage stats only')
  .option('--db <path>', 'Path to graph.db')
  .action(async (opts) => {
    const graph = openGraph(opts.db);

    if (opts.stats) {
      const s = graph.embeddingStats();
      console.log(`Total nodes:    ${s.totalNodes}`);
      console.log(`Embedded nodes: ${s.embeddedNodes}`);
      console.log(`Coverage:       ${s.coveragePct}%`);
      console.log(`Vec available:  ${s.vecAvailable ? '✅' : '❌'}`);
      graph.close();
      process.exit(0);
    }

    const count = await embedAllNodes(graph, opts.category, opts.force ?? false);
    if (count > 0) {
      console.log(`${chalk.green('✅')} Embedded ${count} nodes`);
    } else {
      console.log('No nodes to embed (all already embedded or model unavailable)');
    }

    const s = graph.embeddingStats();
    console.log(`Coverage: ${s.embeddedNodes}/${s.totalNodes} (${s.coveragePct}%)`);
    graph.close();
    process.exit(0);
  });

// ── Consolidation commands ───────────────────────────────────────────────────

program
  .command('parse-log')
  .description('Parse a log file and show entries with salience scores')
  .argument('[path]', 'Path to log file', DEFAULT_LOG)
  .action((logPath: string) => {
    if (!existsSync(logPath)) {
      console.error(chalk.red(`Log file not found: ${logPath}`));
      process.exit(1);
    }

    const entries = parseLogFile(logPath);

    console.log(chalk.bold(`\nLog entries from ${logPath.split(/[\\/]/).pop()}`));
    const table = new Table({
      head: ['Date', 'Type', 'Heading', 'Salience', 'Preview'],
    });

    for (const entry of entries) {
      const salience = scoreEntry(entry);
      table.push([
        entry.date,
        chalk.dim(entry.entryType),
        chalk.bold((entry.heading || '-').slice(0, 30)),
        salienceColor(salience.combined),
        entry.content.slice(0, 50).replace(/\n/g, ' '),
      ]);
    }
    console.log(table.toString());
    console.log(`\n📋 ${entries.length} entries parsed`);
    process.exit(0);
  });

program
  .command('consolidate')
  .description('Run memory consolidation cycle')
  .option('-l, --log <path>', 'Path to log file (md or jsonl)')
  .option('-a, --agent <name>', 'Agent name', 'donna')
  .option('-p, --phase <phase>', 'Phase: nrem, rem, or both', 'both')
  .option('-s, --since <date>', 'Process entries since date (YYYY-MM-DD)')
  .option('--decay-rate <rate>', 'Decay rate for REM phase', '0.05')
  .option('--db <path>', 'Path to graph.db')
  .action(async (opts) => {
    const phase = opts.phase;
    let logPath = resolveLogPath(opts.agent, opts.log);

    if (!logPath) {
      console.log(chalk.yellow(`  ⚠️ No log found for agent '${opts.agent}' (checked JSONL and markdown)`));
      if (phase === 'nrem') {
        process.exit(0);
      }
      // REM phase doesn't need a log
    }

    const graph = openGraph(opts.db);

    if ((phase === 'nrem' || phase === 'both') && logPath) {
      console.log('\n🧠 NREM Phase — Replay + Extract + Transfer');
      console.log(`  Source: ${logPath}`);

      const nrem = await nremReplay(graph, logPath, {
        agentName: opts.agent,
        sinceDate: opts.since,
      });

      console.log(`  Entries processed: ${nrem.entriesProcessed}`);
      console.log(`  Entities extracted: ${nrem.entitiesExtracted}`);
      console.log(`  Nodes added: ${nrem.nodesAdded}`);
      console.log(`  Nodes reinforced: ${nrem.nodesReinforced}`);
      console.log(`  Edges added: ${nrem.edgesAdded}`);

      if (nrem.entriesByType && Object.keys(nrem.entriesByType).length) {
        console.log(`  Entry types: ${JSON.stringify(nrem.entriesByType)}`);
      }

      if (nrem.highSalienceEntries?.length) {
        console.log('\n  🔥 High-salience entries:');
        for (const entry of nrem.highSalienceEntries.slice(0, 10)) {
          console.log(`    ${entry}`);
        }
      }
    }

    if (phase === 'rem' || phase === 'both') {
      console.log('\n💤 REM Phase — Decay + Prune + Refine');
      const rem = remRefine(graph, { decayRate: parseFloat(opts.decayRate) });
      console.log(`  Nodes decayed: ${rem.nodesDecayed}`);
      console.log(`  Nodes pruned: ${rem.nodesPruned}`);
      console.log(`  Edges pruned: ${rem.edgesPruned}`);
    }

    const graphStats = graph.stats();
    console.log(
      `\n📊 Graph state: ${graphStats.nodeCount} nodes, ${graphStats.edgeCount} edges, avg salience ${graphStats.avgSalience.toFixed(3)}`,
    );

    graph.close();
    process.exit(0);
  });

program
  .command('plan')
  .description('Generate a consolidation plan with LLM extraction prompts')
  .option('-a, --agent <name>', 'Agent name', 'donna')
  .option('-l, --log <path>', 'Path to log file')
  .option('-s, --since <date>', 'Process entries since date (YYYY-MM-DD)')
  .option('-b, --batch-size <n>', 'Entries per extraction batch', '5')
  .option('-o, --output <path>', 'Write prompts to JSON file')
  .action((opts) => {
    const logPath = resolveLogPath(opts.agent, opts.log);
    if (!logPath) {
      console.log(chalk.yellow(`  ⚠️ No log found for agent '${opts.agent}'`));
      process.exit(1);
    }

    const entries = parseLogFile(logPath);
    const filtered = opts.since
      ? entries.filter((e) => e.date >= opts.since)
      : entries;

    // Score entries for salience
    const scored = filtered.map((e) => ({ entry: e, salience: scoreEntry(e) }));

    // Build extraction batches
    const batchSize = parseInt(opts.batchSize) || 5;
    const batches: Array<{ batch_id: string; entry_count: number; date_range: string; prompt: string }> = [];
    for (let i = 0; i < scored.length; i += batchSize) {
      const batch = scored.slice(i, i + batchSize);
      const batchText = batch.map((s) => s.entry.content).join('\n\n---\n\n');
      batches.push({
        batch_id: `batch-${Math.floor(i / batchSize) + 1}`,
        entry_count: batch.length,
        date_range: `${batch[0].entry.date} to ${batch[batch.length - 1].entry.date}`,
        prompt: getLlmExtractionPrompt(batchText),
      });
    }

    // Entry type counts
    const typeCounts: Record<string, number> = {};
    for (const e of filtered) {
      typeCounts[e.entryType] = (typeCounts[e.entryType] || 0) + 1;
    }

    // High-salience entries
    const highSalience = scored
      .filter((s) => s.salience.combined >= 0.7)
      .map((s) => `[${s.salience.combined.toFixed(2)}] ${s.entry.heading || s.entry.content.slice(0, 50)}`);

    console.log(`\n📋 Consolidation Plan — ${opts.agent}`);
    console.log(`  Entries to process: ${filtered.length}`);
    console.log(`  Extraction batches: ${batches.length}`);
    console.log(`  Entry types: ${JSON.stringify(typeCounts)}`);

    if (highSalience.length) {
      console.log(`\n  🔥 High-salience entries (${highSalience.length}):`);
      for (const hs of highSalience.slice(0, 10)) {
        console.log(`    ${hs}`);
      }
    }

    if (opts.output) {
      mkdirSync(dirname(opts.output), { recursive: true });
      writeFileSync(opts.output, JSON.stringify(batches, null, 2));
      console.log(`\n  📄 Prompts written to ${opts.output}`);
    } else {
      console.log('\n  Use --output to save prompts for LLM processing');
      for (const p of batches) {
        console.log(`\n  --- ${p.batch_id} (${p.entry_count} entries, ${p.date_range}) ---`);
        console.log(`  ${p.prompt.slice(0, 200)}...`);
      }
    }
    process.exit(0);
  });

program
  .command('load-extractions')
  .description('Load LLM extraction results into the knowledge graph')
  .argument('<file>', 'JSON file with LLM extraction results')
  .option('-a, --agent <name>', 'Agent name', 'donna')
  .option('--db <path>', 'Path to graph.db')
  .action((file: string, opts) => {
    if (!existsSync(file)) {
      console.error(chalk.red(`File not found: ${file}`));
      process.exit(1);
    }

    const content = readFileSync(file, 'utf-8');
    const data = JSON.parse(content) as unknown;

    // Handle both array of JSON strings and array of objects
    const jsonStrings: string[] = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') jsonStrings.push(item);
        else if (typeof item === 'object' && item !== null) jsonStrings.push(JSON.stringify(item));
      }
    } else if (typeof data === 'object' && data !== null) {
      jsonStrings.push(JSON.stringify(data));
    }

    const graph = openGraph(opts.db);
    const totals = { nodesAdded: 0, nodesReinforced: 0, edgesAdded: 0, edgesSkipped: 0 };

    for (const jsonStr of jsonStrings) {
      const result = parseLlmExtraction(jsonStr, opts.agent);
      const stats = loadExtractionToGraph(graph, result);
      totals.nodesAdded += stats.nodesAdded;
      totals.nodesReinforced += stats.nodesReinforced;
      totals.edgesAdded += stats.edgesAdded;
      totals.edgesSkipped += stats.edgesSkipped;
    }

    graph.close();

    console.log(`\n${chalk.green('✅')} Loaded LLM extractions into graph`);
    console.log(`  Nodes added: ${totals.nodesAdded}`);
    console.log(`  Nodes reinforced: ${totals.nodesReinforced}`);
    console.log(`  Edges added: ${totals.edgesAdded}`);
    console.log(`  Edges skipped: ${totals.edgesSkipped}`);
    process.exit(0);
  });

program
  .command('report')
  .description('Post-consolidation report with persona evolution')
  .option('-a, --agent <name>', 'Agent name', 'donna')
  .option('--db <path>', 'Path to graph.db')
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const graph = openGraph(opts.db);
    const s = graph.stats();

    console.log(chalk.bold('\n📊 Post-Consolidation Report'));
    console.log(`  Agent: ${opts.agent}`);
    console.log(`  Nodes: ${s.nodeCount}`);
    console.log(`  Edges: ${s.edgeCount}`);
    console.log(`  Avg salience: ${s.avgSalience.toFixed(3)}`);
    console.log('\n  Type distribution:');
    for (const [type, count] of Object.entries(s.typeDistribution)) {
      console.log(`    ${type}: ${count}`);
    }

    graph.close();

    const diff = generatePersonaDiff(opts.agent, { dbPath });
    console.log(chalk.bold('\n🧬 Persona Evolution'));
    console.log(diff);
    process.exit(0);
  });

// ── Agent subcommands ────────────────────────────────────────────────────────

const agent = program
  .command('agent')
  .description('Agent lifecycle operations');

agent
  .command('boot')
  .description('Generate graph-based domain briefing for an agent')
  .argument('<name>', 'Agent name (e.g., donna, researcher, ado-analyst)')
  .option('-s, --min-salience <n>', 'Minimum salience', '0.3')
  .option('-n, --limit <n>', 'Max nodes', '30')
  .option('--db <path>', 'Path to graph.db')
  .action((name: string, opts) => {
    const briefing = getBootContext(name, {
      dbPath: resolveDbPath(opts.db),
      minSalience: parseFloat(opts.minSalience),
      limit: parseInt(opts.limit),
    });
    console.log(briefing);
    process.exit(0);
  });

agent
  .command('log')
  .description('Log a structured event for an agent')
  .argument('<name>', 'Agent name')
  .argument('<type>', `Event type: ${VALID_LOG_TYPES.join(', ')}`)
  .argument('<summary>', 'One-line summary')
  .option('-d, --detail <text>', 'Extended detail', '')
  .option('-t, --tag <tag>', 'Tags (repeatable)', collect, [] as string[])
  .option('-s, --session-id <id>', 'Copilot session ID', '')
  .action((name: string, entryType: string, summary: string, opts) => {
    if (!(VALID_LOG_TYPES as readonly string[]).includes(entryType)) {
      console.error(chalk.red(`❌ Invalid type '${entryType}'. Must be one of: ${VALID_LOG_TYPES.join(', ')}`));
      process.exit(1);
    }

    appendStructuredLog(name, entryType, summary, {
      detail: opts.detail,
      sessionId: opts.sessionId,
      tags: opts.tag,
      context: {},
    });

    console.log(`${chalk.green('✅')} [${entryType}] ${name}: ${summary}`);
    process.exit(0);
  });

agent
  .command('log-show')
  .description('Show structured log entries for an agent')
  .argument('<name>', 'Agent name')
  .option('-t, --type <type>', 'Filter by event type')
  .option('-s, --since <date>', 'Filter since date (YYYY-MM-DD)')
  .option('-n, --limit <n>', 'Max entries to show', '20')
  .action((name: string, opts) => {
    const entries = readLogEntries(name, {
      sinceDate: opts.since,
      entryType: opts.type,
      limit: parseInt(opts.limit),
    });

    if (!entries.length) {
      console.log(`No log entries found for ${name}`);
      process.exit(0);
    }

    console.log(chalk.bold(`\nLog — ${name} (${entries.length} entries)`));
    const table = new Table({
      head: ['Time', 'Type', 'Summary', 'Tags'],
      colWidths: [21, 14, null, 20],
    });

    for (const e of entries) {
      table.push([
        chalk.dim(e.ts.slice(0, 19)),
        e.type,
        e.summary.slice(0, 80),
        chalk.dim(e.tags?.join(', ') ?? ''),
      ]);
    }
    console.log(table.toString());
    process.exit(0);
  });

agent
  .command('evolve')
  .description('Generate persona evolution suggestions from graph knowledge')
  .argument('<name>', 'Agent name')
  .option('-s, --min-salience <n>', 'Minimum salience', '0.6')
  .option('--db <path>', 'Path to graph.db')
  .action((name: string, opts) => {
    const diff = generatePersonaDiff(name, {
      dbPath: resolveDbPath(opts.db),
      minSalience: parseFloat(opts.minSalience),
    });
    console.log(diff);
    console.log(chalk.dim("\n💡 Review the suggestions above and apply them to the agent's definition file"));
    process.exit(0);
  });

agent
  .command('instructions')
  .description('Print log-writing instructions to embed in an agent definition')
  .argument('<name>', 'Agent name')
  .action((name: string) => {
    const instructions = getAgentLogInstructions(name);
    console.log(instructions);
    process.exit(0);
  });

// ── Code command (placeholder) ───────────────────────────────────────────────

program
  .command('parse')
  .description('Index a repository into the knowledge graph')
  .argument('<repo-path>', 'Path to the git repository root')
  .option('--db <path>', 'Path to graph.db')
  .action((repoPath: string, _opts) => {
    if (!existsSync(repoPath)) {
      console.error(chalk.red(`Repository path does not exist: ${repoPath}`));
      process.exit(1);
    }
    console.log(chalk.yellow('Code parsing not yet ported'));
    process.exit(0);
  });

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err: Error) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
