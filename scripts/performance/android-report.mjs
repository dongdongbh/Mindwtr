import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize } from './report.mjs';

export function parseAndroidReport(csv, phases, metadata) {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const names = header.split(',');
  const runs = lines.filter(Boolean).map((line) => Object.fromEntries(line.split(',').map((value, i) => [names[i], value])));
  const ready = metadata.scenario === 'cold' ? 'js.interactive_ready' : 'js.resume_ready';
  const readySamples = phases.trim().split(/\r?\n/).slice(1).map((line) => line.split('\t'))
    .filter(([, phase, value]) => phase === ready && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0);
  const unique = new Map(readySamples.map(([id, , value]) => [id, Number(value)]));
  const valid = runs.filter((run) => run.sample_quality === 'ok'
    && run.total_time_ms !== '' && Number.isFinite(Number(run.total_time_ms)) && Number(run.total_time_ms) >= 0
    && (metadata.scenario === 'warm' || unique.has(run.run)));
  const metrics = { [metadata.scenario === 'hot' ? 'nativeResumeDispatch' : 'initialDisplay']: summarize(valid.map((run) => Number(run.total_time_ms))) };
  // Cold is measured since JS profiler load; resume is measured since AppState active.
  // A warm native activity may reuse or recreate JS. Do not mix those clocks.
  if (metadata.scenario !== 'warm') metrics[metadata.scenario === 'cold' ? 'jsInteractive' : 'jsResume'] = summarize(valid.map((run) => unique.get(run.run)));
  return { schemaVersion: 1, metadata, sampleCount: runs.length, invalidSamples: runs.length - valid.length,
    warnings: valid.length < 100 ? ['Fewer than 100 valid samples: p95 is descriptive only, not a regression gate.'] : [], metrics };
}

if (process.argv[1]?.endsWith('android-report.mjs')) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error('Expected benchmark directory');
  const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
  const report = parseAndroidReport(readFileSync(join(directory, 'am_start_results.csv'), 'utf8'),
    readFileSync(join(directory, metadata.scenario === 'cold' ? 'js_since_start.tsv' : 'phase_durations.tsv'), 'utf8'), metadata);
  writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.invalidSamples || Object.values(report.metrics).some((metric) => metric.count === 0)) process.exitCode = 1;
}
