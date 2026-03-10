import type { ParsedFile } from '../models.js';

export abstract class BaseParser {
  abstract parseFile(filePath: string, source: Buffer, relativePath: string): ParsedFile;
}
