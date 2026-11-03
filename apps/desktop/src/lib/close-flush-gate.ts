import { raceCloseFlush, type CloseFlushRaceOptions, type CloseFlushRaceResult } from './close-flush-race';


let closeSequenceFlushPromise: Promise<CloseFlushRaceResult> | null = null;

export function beginCloseFlush(options: CloseFlushRaceOptions): Promise<CloseFlushRaceResult> {
    if (!closeSequenceFlushPromise) closeSequenceFlushPromise = raceCloseFlush(options);
    return closeSequenceFlushPromise;
}


export function resetCloseFlushGate(): void {
    closeSequenceFlushPromise = null;
}
