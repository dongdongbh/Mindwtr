import { traceSection } from './perf-trace';

/**
 * Cooperative passes (D9). A long pure pass over the library is written once, as a generator whose bare `yield` marks a
 * point where it may give the thread back. Every caller that wants the old behavior runs it to the end at once
 * ({@link runToEnd}: the same result, no await). A host that binds a yield (the native Android host: a zero-delay timer, so
 * the engine serves the screens' calls queued meanwhile) runs it in slices of about {@link SLICE_BUDGET_MS}
 * ({@link runSliced}). A pass may yield only where nothing it holds can change under it: it reads snapshots, never the live
 * store or the database, and writes nothing.
 */
export type CooperativePass<T> = Generator<void, T, void>;

/** Items a pass handles between two yield points. */
export const SLICE_ITEMS = 64;
/** About how long one slice runs before the pass gives the thread back. */
export const SLICE_BUDGET_MS = 8;

export const runToEnd = <T>(pass: CooperativePass<T>): T => {
    let step = pass.next();
    while (!step.done) step = pass.next();
    return step.value;
};

const now = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/** One cycle's slice clock: a slice ends once it has run for the budget; the yield gives the thread back and starts the next. */
export type Slicer = {
    due(): boolean;
    yield(): Promise<void>;
};

export const createSlicer = (yieldToHost: () => Promise<void>, budgetMs: number = SLICE_BUDGET_MS): Slicer => {
    let sliceStart = now();
    return {
        due: () => now() - sliceStart >= budgetMs,
        yield: async () => {
            await yieldToHost();
            sliceStart = now();
        },
    };
};

/**
 * Runs [pass] in slices when there is a [slicer], each slice a trace section named [name]; at once (one section) without.
 * A section never spans a yield, so the trace shows each uninterrupted stretch.
 */
export const runSliced = async <T>(name: string, pass: CooperativePass<T>, slicer?: Slicer): Promise<T> => {
    if (!slicer) return traceSection(name, () => runToEnd(pass));
    for (;;) {
        const step = traceSection(name, () => {
            let next = pass.next();
            while (!next.done && !slicer.due()) next = pass.next();
            return next;
        });
        if (step.done) return step.value;
        await slicer.yield();
    }
};

/** `items.map(map)` as a pass: a yield point every {@link SLICE_ITEMS} items. */
export function* mapPass<T, U>(items: readonly T[], map: (item: T, index: number) => U): CooperativePass<U[]> {
    const out: U[] = new Array(items.length);
    for (let index = 0; index < items.length; index += 1) {
        out[index] = map(items[index], index);
        if ((index + 1) % SLICE_ITEMS === 0) yield;
    }
    return out;
}
