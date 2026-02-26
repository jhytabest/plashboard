import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nowIso(): string {
  return new Date().toISOString();
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const targetDir = dirname(path);
  await ensureDir(targetDir);
  const tmpBase = await mkdtemp(join(targetDir, '.plashboard-write-'));
  const tmpPath = join(tmpBase, 'next.json');
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmpPath, path);
  await rm(tmpBase, { recursive: true, force: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function asErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
