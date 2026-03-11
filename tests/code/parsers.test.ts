/**
 * Tests for code parsers — language-specific AST parsing.
 *
 * Tests each parser against representative source code snippets.
 * Tree-sitter is a native module — these tests verify it loads and produces correct entities.
 */

import { describe, it, expect } from 'vitest';
import { getParser } from '../../src/code/parsers/index.js';

// ---------------------------------------------------------------------------
// Parser registry
// ---------------------------------------------------------------------------

describe('getParser', () => {
  it('returns parser for typescript', () => {
    expect(getParser('typescript')).not.toBeNull();
  });

  it('returns parser for python', () => {
    expect(getParser('python')).not.toBeNull();
  });

  it('returns parser for go', () => {
    expect(getParser('go')).not.toBeNull();
  });

  it('returns parser for json', () => {
    expect(getParser('json')).not.toBeNull();
  });

  it('returns parser for yaml', () => {
    expect(getParser('yaml')).not.toBeNull();
  });

  it('returns parser for dockerfile', () => {
    expect(getParser('dockerfile')).not.toBeNull();
  });

  it('returns parser for csharp', () => {
    expect(getParser('csharp')).not.toBeNull();
  });

  it('returns null for unknown language', () => {
    expect(getParser('brainfuck')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TypeScript parser
// ---------------------------------------------------------------------------

describe('TypeScript parser', () => {
  const parser = getParser('typescript')!;

  it('extracts class declarations', () => {
    const source = `
export class MyService {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return "hello " + this.name;
  }
}
`;
    const result = parser.parseFile('src/service.ts', Buffer.from(source), 'src/service.ts');
    expect(result.language).toBe('typescript');
    expect(result.filePath).toBe('src/service.ts');

    const classEntity = result.entities.find(e => e.name === 'MyService');
    expect(classEntity).toBeDefined();
    expect(classEntity!.entityType).toBe('class');

    // Should have method members
    const methods = classEntity!.members.filter(m => m.entityType === 'method');
    expect(methods.some(m => m.name === 'greet')).toBe(true);
  });

  it('extracts interface declarations', () => {
    const source = `
export interface Config {
  host: string;
  port: number;
  debug?: boolean;
}
`;
    const result = parser.parseFile('src/config.ts', Buffer.from(source), 'src/config.ts');
    const iface = result.entities.find(e => e.name === 'Config');
    expect(iface).toBeDefined();
    expect(iface!.entityType).toBe('interface');
  });

  it('extracts standalone functions', () => {
    const source = `
export function calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}
`;
    const result = parser.parseFile('src/utils.ts', Buffer.from(source), 'src/utils.ts');
    const func = result.entities.find(e => e.name === 'calculateTotal');
    expect(func).toBeDefined();
    expect(func!.entityType).toBe('function');
  });

  it('extracts import statements', () => {
    const source = `
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function readConfig(): string {
  return readFileSync(path.join('.', 'config.json'), 'utf-8');
}
`;
    const result = parser.parseFile('src/reader.ts', Buffer.from(source), 'src/reader.ts');
    expect(result.usingDirectives).toContain('node:fs');
    expect(result.usingDirectives).toContain('node:path');
  });

  it('extracts enum declarations', () => {
    const source = `
export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}
`;
    const result = parser.parseFile('src/types.ts', Buffer.from(source), 'src/types.ts');
    const enumEntity = result.entities.find(e => e.name === 'Status');
    expect(enumEntity).toBeDefined();
    expect(enumEntity!.entityType).toBe('enum');
  });

  it('handles empty file', () => {
    const result = parser.parseFile('empty.ts', Buffer.from(''), 'empty.ts');
    expect(result.entities).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Python parser
// ---------------------------------------------------------------------------

describe('Python parser', () => {
  const parser = getParser('python')!;

  it('extracts class declarations', () => {
    const source = `
class Animal:
    def __init__(self, name: str):
        self.name = name

    def speak(self) -> str:
        return f"{self.name} says hello"
`;
    const result = parser.parseFile('animal.py', Buffer.from(source), 'animal.py');
    const cls = result.entities.find(e => e.name === 'Animal');
    expect(cls).toBeDefined();
    expect(cls!.entityType).toBe('class');
    // Should have method members
    expect(cls!.members.some(m => m.name === 'speak')).toBe(true);
  });

  it('extracts standalone functions', () => {
    const source = `
def greet(name: str) -> str:
    return f"Hello, {name}!"
`;
    const result = parser.parseFile('utils.py', Buffer.from(source), 'utils.py');
    const func = result.entities.find(e => e.name === 'greet');
    expect(func).toBeDefined();
    expect(func!.entityType).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Go parser
// ---------------------------------------------------------------------------

describe('Go parser', () => {
  const parser = getParser('go')!;

  it('extracts struct declarations', () => {
    const source = `
package main

type Server struct {
    Host string
    Port int
}

func (s *Server) Start() error {
    return nil
}
`;
    const result = parser.parseFile('main.go', Buffer.from(source), 'main.go');
    const structEntity = result.entities.find(e => e.name === 'Server');
    expect(structEntity).toBeDefined();
    expect(structEntity!.entityType).toBe('struct');
  });

  it('extracts standalone functions', () => {
    const source = `
package main

func main() {
    println("hello")
}
`;
    const result = parser.parseFile('main.go', Buffer.from(source), 'main.go');
    const func = result.entities.find(e => e.name === 'main');
    expect(func).toBeDefined();
    expect(func!.entityType).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// JSON parser
// ---------------------------------------------------------------------------

describe('JSON parser', () => {
  const parser = getParser('json')!;

  it('extracts top-level keys from object', () => {
    const source = JSON.stringify({
      name: "myelin",
      version: "1.0.0",
      scripts: { build: "tsc", test: "vitest" },
    }, null, 2);
    const result = parser.parseFile('package.json', Buffer.from(source), 'package.json');
    expect(result.entities.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Dockerfile parser
// ---------------------------------------------------------------------------

describe('Dockerfile parser', () => {
  const parser = getParser('dockerfile')!;

  it('extracts FROM base images', () => {
    const source = `
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
`;
    const result = parser.parseFile('Dockerfile', Buffer.from(source), 'Dockerfile');
    expect(result.entities.length).toBeGreaterThan(0);
    // Should find base image entities
    const fromEntities = result.entities.filter(e =>
      e.name.includes('node') || e.entityType === 'stage'
    );
    expect(fromEntities.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// YAML parser
// ---------------------------------------------------------------------------

describe('YAML parser', () => {
  const parser = getParser('yaml')!;

  it('extracts top-level keys', () => {
    const source = `
name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
`;
    const result = parser.parseFile('.github/workflows/ci.yml', Buffer.from(source), '.github/workflows/ci.yml');
    expect(result.entities.length).toBeGreaterThan(0);
  });
});
