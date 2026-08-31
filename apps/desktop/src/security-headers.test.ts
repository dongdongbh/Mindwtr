import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const headers = readFileSync(join(process.cwd(), 'public/_headers'), 'utf8');
const nginxConfig = readFileSync(join(process.cwd(), '../../docker/app/nginx.conf'), 'utf8');

const sharedSecurityHeaders = [
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
] as const;

function parseStaticHeaders(source: string): Map<string, string> {
  return new Map(
    source
      .split('\n')
      .map((line) => line.trim().match(/^([^:]+):\s*(.+)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1], match[2]]),
  );
}

function parseNginxResponseBlocks(source: string): Array<{
  name: string;
  headers: Map<string, string>;
}> {
  const blocks: Array<{ name: string; headers: Map<string, string> }> = [];
  const stack: Array<{ name: string; headers: Map<string, string> }> = [];

  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const opening = trimmed.match(/^(server|location\s+[^{}]+)\s*\{$/);
    if (opening) {
      const block = { name: opening[1].trim(), headers: new Map<string, string>() };
      blocks.push(block);
      stack.push(block);
      continue;
    }

    const header = trimmed.match(/^add_header\s+([^\s]+)\s+"([^"]*)"\s+always;$/);
    if (header && stack.length > 0) {
      stack[stack.length - 1].headers.set(header[1], header[2]);
      continue;
    }

    if (trimmed === '}') {
      stack.pop();
    }
  }

  return blocks;
}

describe('desktop static security headers', () => {
  it('ships a CSP for hosted PWA builds without inline scripts or embeddable content', () => {
    expect(headers).toContain('Content-Security-Policy:');
    expect(headers).toContain("script-src 'self'");
    expect(headers).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(headers).toContain("object-src 'none'");
    expect(headers).toContain("frame-src 'none'");
    expect(headers).toContain("base-uri 'self'");
  });

  it('keeps browser hardening headers with the static CSP', () => {
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: no-referrer');
    expect(headers).toContain('Permissions-Policy: camera=(), microphone=(), geolocation=()');
  });

  it('keeps every Docker response block in semantic parity with the hosted PWA policy', () => {
    const authoritativeHeaders = parseStaticHeaders(headers);
    const responseBlocks = parseNginxResponseBlocks(nginxConfig);

    expect(responseBlocks.map((block) => block.name)).toEqual([
      'server',
      'location /assets/',
      'location /',
    ]);
    for (const block of responseBlocks) {
      for (const header of sharedSecurityHeaders) {
        expect(block.headers.get(header), `${block.name}: ${header}`).toBe(
          authoritativeHeaders.get(header),
        );
      }
    }
  });
});
