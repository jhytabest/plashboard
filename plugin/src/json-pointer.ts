export function decodeToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function parsePointer(pointer: string): string[] {
  if (!pointer.startsWith('/')) {
    throw new Error(`invalid pointer: ${pointer}`);
  }
  if (pointer === '/') return [''];
  return pointer.slice(1).split('/').map(decodeToken);
}

function isArrayIndex(token: string): boolean {
  return /^\d+$/.test(token);
}

export function readPointer(root: unknown, pointer: string): unknown {
  const tokens = parsePointer(pointer);
  let cursor: unknown = root;

  for (const token of tokens) {
    if (Array.isArray(cursor)) {
      if (!isArrayIndex(token)) {
        throw new Error(`pointer token must be numeric for array: ${pointer}`);
      }
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        throw new Error(`array index out of range for pointer: ${pointer}`);
      }
      cursor = cursor[index];
      continue;
    }

    if (cursor && typeof cursor === 'object') {
      const record = cursor as Record<string, unknown>;
      if (!(token in record)) {
        throw new Error(`pointer path not found: ${pointer}`);
      }
      cursor = record[token];
      continue;
    }

    throw new Error(`pointer path not found: ${pointer}`);
  }

  return cursor;
}

export function writePointer(root: unknown, pointer: string, value: unknown): void {
  const tokens = parsePointer(pointer);
  if (!tokens.length) throw new Error(`invalid pointer: ${pointer}`);

  let cursor: unknown = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];

    if (Array.isArray(cursor)) {
      if (!isArrayIndex(token)) {
        throw new Error(`pointer token must be numeric for array: ${pointer}`);
      }
      const arrayIndex = Number(token);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= cursor.length) {
        throw new Error(`array index out of range for pointer: ${pointer}`);
      }
      cursor = cursor[arrayIndex];
      continue;
    }

    if (!cursor || typeof cursor !== 'object') {
      throw new Error(`pointer path not found: ${pointer}`);
    }

    const record = cursor as Record<string, unknown>;
    if (!(token in record)) {
      throw new Error(`pointer path not found: ${pointer}`);
    }
    cursor = record[token];
  }

  const last = tokens[tokens.length - 1];
  if (Array.isArray(cursor)) {
    if (!isArrayIndex(last)) {
      throw new Error(`pointer token must be numeric for array: ${pointer}`);
    }
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
      throw new Error(`array index out of range for pointer: ${pointer}`);
    }
    cursor[index] = value;
    return;
  }

  if (!cursor || typeof cursor !== 'object') {
    throw new Error(`pointer path not found: ${pointer}`);
  }

  const record = cursor as Record<string, unknown>;
  if (!(last in record)) {
    throw new Error(`pointer path not found: ${pointer}`);
  }
  record[last] = value;
}
