/**
 * Language parser registry.
 * Ported from cortex/code/parsers/__init__.py
 */

import { CSharpParser } from './csharp.js';
import { TypeScriptParser } from './typescript.js';
import { PythonParser } from './python.js';
import { GoParser } from './go.js';
import { JsonParser } from './json.js';
import { YamlParser } from './yaml.js';
import { DockerfileParser } from './dockerfile.js';
import type { BaseParser } from './base.js';

export function getParser(language: string): BaseParser | null {
  switch (language) {
    case 'csharp':
      return new CSharpParser();
    case 'typescript':
      return new TypeScriptParser(false);
    case 'tsx':
      return new TypeScriptParser(true);
    case 'python':
      return new PythonParser();
    case 'go':
      return new GoParser();
    case 'json':
      return new JsonParser();
    case 'yaml':
      return new YamlParser();
    case 'dockerfile':
      return new DockerfileParser();
    default:
      return null;
  }
}

export { BaseParser } from './base.js';
