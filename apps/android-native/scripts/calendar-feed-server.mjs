// A local ICS subscription for the device checks (pass C3), served on this computer and reached from the phone through
// `adb reverse`. It runs on a worker thread: a check's adb calls are synchronous and would hold a request on this thread's
// event loop. `/<name>.ics` answers by the mode set for it: "ok" (the calendar), "slow" (the calendar after 15 s), 403, 500,
// "truncated" (a Content-Length the body never reaches, then the socket closes) or "oversized" (a declared length past any
// limit, never sent). Every request's
// path and Origin header come back in `seen`.
import { Worker } from 'node:worker_threads';

const SOURCE = `
    const { createServer } = require('node:http');
    const { parentPort, workerData: { port } } = require('node:worker_threads');
    const modes = {};
    let body = '';
    parentPort.on('message', (message) => {
        if (message.body !== undefined) body = message.body;
        if (message.mode) modes[message.mode.name] = message.mode.value;
    });
    const server = createServer((request, response) => {
        const name = (request.url ?? '').replace(/^\\//, '').replace(/\\.ics.*$/, '');
        const mode = modes[name] ?? 'ok';
        parentPort.postMessage({ path: request.url, origin: request.headers.origin ?? null, mode, at: new Date().toISOString().slice(11, 23) });
        if (mode === '403' || mode === '500') { response.writeHead(Number(mode), { 'content-type': 'text/plain' }); response.end('refused'); return; }
        if (mode === 'truncated') {
            response.writeHead(200, { 'content-type': 'text/calendar', 'content-length': String(Buffer.byteLength(body) + 4096) });
            response.write(body.slice(0, Math.floor(body.length / 2)));
            setTimeout(() => response.socket.destroy(), 200);
            return;
        }
        if (mode === 'oversized') {
            response.writeHead(200, { 'content-type': 'text/calendar', 'content-length': String(4 * 1024 * 1024 * 1024) });
            response.write(body.slice(0, 64));
            setTimeout(() => response.socket.destroy(), 500);
            return;
        }
        const answer = () => { response.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' }); response.end(body); };
        if (mode === 'slow') { setTimeout(answer, 15000); return; }
        answer();
    });
    server.listen(port, '127.0.0.1', () => parentPort.postMessage({ listening: true }));
`;

/** Local wall-clock ICS values (floating times and DATE values read as the phone's local day). */
const day = (offset) => {
    const date = new Date(Date.now() + offset * 86_400_000);
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
};

/** The hour the timed event starts: this one, so the Calendar's timeline (scrolled to now) shows it (22 at the latest). */
export const eventHour = () => Math.min(new Date().getHours(), 22);
const hh = (hour) => String(hour).padStart(2, '0');

/**
 * A calendar with a timed event today ([timed], this hour, one hour long) and an all-day event tomorrow ([allDay]), plus one
 * more all-day event tomorrow for each title in [moreAllDay] (rows stacked in the day view's all-day card).
 */
export const icsCalendar = ({ timed, allDay, moreAllDay = [], name = 'Team calendar' }) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mindwtr check//EN', `X-WR-CALNAME:${name}`,
    'BEGIN:VEVENT', 'UID:check-timed@mindwtr', `DTSTART:${day(0)}T${hh(eventHour())}0000`, `DTEND:${day(0)}T${hh(eventHour() + 1)}0000`, `SUMMARY:${timed}`, 'END:VEVENT',
    ...[allDay, ...moreAllDay].flatMap((title, index) => ['BEGIN:VEVENT', `UID:check-all-day${index || ''}@mindwtr`,
        `DTSTART;VALUE=DATE:${day(1)}`, `DTEND;VALUE=DATE:${day(2)}`, `SUMMARY:${title}`, 'END:VEVENT']),
    'END:VCALENDAR', '',
].join('\r\n');

export const serveCalendar = (port, body) => new Promise((resolveServer, rejectServer) => {
    const worker = new Worker(SOURCE, { eval: true, workerData: { port } });
    const state = {
        seen: [],
        /** The answer for `/<name>.ics`. */
        mode(name, value) { worker.postMessage({ mode: { name, value } }); },
    };
    worker.postMessage({ body });
    worker.on('message', (message) => {
        if (message.listening) resolveServer({ state, close: () => worker.terminate() });
        else state.seen.push(message);
    });
    worker.on('error', rejectServer);
});
