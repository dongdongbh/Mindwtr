
export function afterPaint(
    callback: () => void,
    schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
    cancel: (id: number) => void = cancelAnimationFrame,
): () => void {
    let active = true;
    let frame = schedule(() => {
        if (!active) return;
        frame = schedule(() => {
            if (!active) return;
            active = false;
            callback();
        });
    });
    return () => { active = false; cancel(frame); };
}
