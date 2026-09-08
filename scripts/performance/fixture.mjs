import { createHash } from 'node:crypto';

/** Synthetic, fixed dates: never import a real user's export into a benchmark. */
export function fixture(count) {
  if (!Number.isInteger(count) || count < 0 || count > 50000) throw new Error('Fixture size must be 0..50000');
  const timestamp = '2020-01-01T00:00:00.000Z';
  const statuses = ['inbox', 'next', 'waiting', 'someday', 'done'];
  const data = {
    tasks: Array.from({ length: count }, (_, i) => ({
      id: `perf-task-${i}`, title: `Synthetic task ${i}`, status: statuses[i % statuses.length],
      contexts: [`@context-${i % 4}`], tags: [`tag-${i % 7}`],
      ...(i % 3 === 0 ? { projectId: `perf-project-${i % 20}` } : {}),
      createdAt: timestamp, updatedAt: timestamp,
    })),
    projects: count ? Array.from({ length: 20 }, (_, i) => ({
      id: `perf-project-${i}`, title: `Synthetic project ${i}`, status: 'active', color: '#94a3b8',
      createdAt: timestamp, updatedAt: timestamp,
    })) : [],
    sections: [], areas: [], people: [], settings: { language: 'en' },
  };
  const payload = JSON.stringify(data);
  return { data, payload, id: `mixed-v1-${count}-${createHash('sha256').update(payload).digest('hex').slice(0, 16)}` };
}
