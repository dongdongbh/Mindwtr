import { traceSection } from './perf-trace';


export type CooperativePass<T> = Generator<void, T, void>;


export const SLICE_ITEMS = 64;

export const SLICE_BUDGET_MS = 8;

export const runToEnd = <T>(pass: CooperativePass<T>): T => {
    let step = pass.next();
    while (!step.done) step = pass.next();
    return step.value;
};

const now = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());


export type Slicer = {
    due(): boolean;
    yield(): Promise<void>;

    ran(ms: number): void;


    stats(): { slices: number; longestMs: number };
};

export const createSlicer = (yieldToHost: () => Promise<void>, budgetMs: number = SLICE_BUDGET_MS): Slicer => {
    let sliceStart = now();
    let slices = 0;
    let longestMs = 0;
    return {
        due: () => now() - sliceStart >= budgetMs,
        yield: async () => {
            slices += 1;
            await yieldToHost();
            sliceStart = now();
        },
        ran: (ms) => { longestMs = Math.max(longestMs, ms); },
        stats: () => ({ slices, longestMs }),
    };
};


export const runSliced = async <T>(name: string, pass: CooperativePass<T>, slicer?: Slicer): Promise<T> => {
    if (!slicer) return traceSection(name, () => runToEnd(pass));
    for (;;) {
        const started = now();
        const step = traceSection(name, () => {
            let next = pass.next();
            while (!next.done && !slicer.due()) next = pass.next();
            return next;
        });
        slicer.ran(now() - started);
        if (step.done) return step.value;
        await slicer.yield();
    }
};


export function* mapPass<T, U>(items: readonly T[], map: (item: T, index: number) => U): CooperativePass<U[]> {
    const out: U[] = new Array(items.length);
    for (let index = 0; index < items.length; index += 1) {
        out[index] = map(items[index], index);
        if ((index + 1) % SLICE_ITEMS === 0) yield;
    }
    return out;
}
