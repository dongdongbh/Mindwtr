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

function parseContentSecurityPolicy(source: string): Map<string, string[]> {
  return new Map(
    source.split(';').map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name !== '')
      .map(([name, ...sources]) => [name, sources]),
  );
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

  it('only maps safe DNS or IPv4 hostnames into the Docker connection source', () => {
    const hostMap = nginxConfig.match(/map\s+\$host\s+\$mindwtr_same_host_connect_src\s*\{([^}]+)\}/)?.[1];
    expect(hostMap).toMatch(/default\s+"";/);
    const hostnameRule = hostMap?.match(/~([^\s]+)\s+"\$scheme:\/\/\$host:\*";/)?.[1];
    expect(hostnameRule).toBeDefined();
    const matchesAllowedHost = new RegExp(hostnameRule ?? 'a^');
    for (const hostname of ['localhost', '192.168.1.50', 'mindwtr.example', 'my-server.lan']) {
      expect(matchesAllowedHost.test(hostname), hostname).toBe(true);
    }
    for (const hostname of [
      'host.test;object-src', 'host.test;base-uri', 'host.test\'unsafe-inline\'',
      'host.test connect-src *', 'host.test/path', 'host.test:8787', '[::1]',
    ]) {
      expect(matchesAllowedHost.test(hostname), hostname).toBe(false);
    }
  });

  it('keeps every Docker response block in parity with only a same-host connection exception', () => {
    const authoritativeHeaders = parseStaticHeaders(headers);
    const responseBlocks = parseNginxResponseBlocks(nginxConfig);
    const dockerPolicy = parseContentSecurityPolicy(authoritativeHeaders.get('Content-Security-Policy') ?? '');
    dockerPolicy.set('connect-src', [
      ...dockerPolicy.get('connect-src') ?? [],
      '$mindwtr_same_host_connect_src',
    ]);

    expect(responseBlocks.map((block) => block.name)).toEqual([
      'server',
      'location /assets/',
      'location /',
    ]);
    for (const block of responseBlocks) {
      for (const header of sharedSecurityHeaders) {
        if (header === 'Content-Security-Policy') {
          expect(parseContentSecurityPolicy(block.headers.get(header) ?? ''), block.name).toEqual(dockerPolicy);
          continue;
        }
        expect(block.headers.get(header), `${block.name}: ${header}`).toBe(
          authoritativeHeaders.get(header),
        );
      }
    }
  });
});
