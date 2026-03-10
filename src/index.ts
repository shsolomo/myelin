// Public API
export {
  KnowledgeGraph,
  NodeType,
  RelationshipType,
} from './memory/graph.js';

export type {
  Node,
  Edge,
  FindNodesFilters,
  SubgraphFilters,
  GraphStats,
  EmbeddingStats,
} from './memory/graph.js';

export {
  SCHEMA_SQL,
  CODE_SCHEMA_EXTENSIONS,
  initSchema,
  extendSchemaForCode,
} from './memory/schema.js';
