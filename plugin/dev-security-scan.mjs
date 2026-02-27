import { readdir, readFile } from 'node:fs/promises';

const ROOT = new URL('./src/', import.meta.url);

const RULES = [
  {
    id: 'no-child-process',
    pattern: /node:child_process/g,
    message: 'Disallowed import: node:child_process'
  },
  {
    id: 'no-process-env',
    pattern: /\bprocess\.env\b/g,
    message: 'Disallowed direct environment access: process.env'
  }
];

async function listFiles(dirUrl) {
  const entries = await readdir(dirUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dirUrl);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryUrl));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      files.push(entryUrl);
    }
  }
  return files;
}

function toRelative(url) {
  return url.pathname.replace(/.*\/plugin\//, 'plugin/');
}

function findMatches(content, pattern) {
  const matches = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    matches.push(match.index);
  }
  return matches;
}

function offsetToLine(content, offset) {
  const prefix = content.slice(0, offset);
  return prefix.split('\n').length;
}

async function main() {
  const files = await listFiles(ROOT);
  const violations = [];

  for (const fileUrl of files) {
    const content = await readFile(fileUrl, 'utf8');
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      const hits = findMatches(content, rule.pattern);
      for (const hit of hits) {
        violations.push({
          file: toRelative(fileUrl),
          line: offsetToLine(content, hit),
          rule: rule.id,
          message: rule.message
        });
      }
    }
  }

  if (!violations.length) {
    console.log('security scan passed: no banned patterns in plugin/src');
    return;
  }

  console.error('security scan failed: banned patterns found');
  for (const violation of violations) {
    console.error(`- [${violation.rule}] ${violation.file}:${violation.line} ${violation.message}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`security scan failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
