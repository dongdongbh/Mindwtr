import { writeFileSync } from 'node:fs';

// This is opt-in diagnostic sampling, never part of ordinary timing runs.
// A null output avoids even opening a DevTools session.
export async function profileBrowserWork(context, page, output, work) {
  if (!output) return work();
  const session = await context.newCDPSession(page);
  let started = false;
  let result;
  let failure;
  let failed = false;
  const rememberFailure = (error) => {
    if (!failed) { failure = error; failed = true; }
  };
  try {
    await session.send('Profiler.enable');
    await session.send('Profiler.setSamplingInterval', { interval: 1000 });
    await session.send('Profiler.start');
    started = true;
    result = await work();
  } catch (error) { rememberFailure(error); }
  try {
    if (started) {
      const { profile } = await session.send('Profiler.stop');
      writeFileSync(output, `${JSON.stringify(profile)}\n`);
    }
  } catch (error) { rememberFailure(error); }
  try { await session.detach(); } catch (error) { rememberFailure(error); }
  if (failed) throw failure;
  return result;
}
