import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderSvgToPng, saveShareCardPng } from "./share-card-export";

const mocks = vi.hoisted(() => ({
    isTauriRuntime: vi.fn(() => false),
    logInfo: vi.fn(async () => null),
    save: vi.fn(async () => null as string | null),
    writeFile: vi.fn(async () => undefined),
}));

vi.mock("./runtime", () => ({ isTauriRuntime: mocks.isTauriRuntime }));
vi.mock("./app-log", () => ({ logInfo: mocks.logInfo }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: mocks.writeFile }));

describe("saveShareCardPng", () => {
    const createObjectUrl = vi.fn(() => "blob:share-card");
    const revokeObjectUrl = vi.fn();
    let click: ReturnType<typeof vi.spyOn>;
    let clickedDownload = '';

    beforeEach(() => {
        mocks.isTauriRuntime.mockReturnValue(false);
        mocks.logInfo.mockClear();
        mocks.save.mockReset().mockResolvedValue(null);
        mocks.writeFile.mockClear();
        createObjectUrl.mockClear();
        revokeObjectUrl.mockClear();
        clickedDownload = '';
        vi.stubGlobal("URL", {
            ...URL,
            createObjectURL: createObjectUrl,
            revokeObjectURL: revokeObjectUrl,
        });
        click = vi
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(function (this: HTMLAnchorElement) {
                clickedDownload = this.download;
            });
    });

    afterEach(() => {
        vi.useRealTimers();
        click?.mockRestore();
        vi.unstubAllGlobals();
    });

    it('times out stalled load and encode callbacks and allows a later render to recover', async () => {
        vi.useFakeTimers();
        const images: Array<{
            onload: (() => void) | null;
            onerror: (() => void) | null;
        }> = [];
        class TestImage {
            decoding = '';
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;

            set src(_value: string) {
                images.push(this);
            }
        }
        vi.stubGlobal('Image', TestImage);

        const drawImage = vi.fn();
        let lateEncode: BlobCallback | undefined;
        const toBlob = vi.fn((callback: BlobCallback) => {
            if (!lateEncode) {
                lateEncode = callback;
                return;
            }
            callback(new Blob(['png'], { type: 'image/png' }));
        });
        const originalCreateElement = document.createElement.bind(document);
        const createElement = vi
            .spyOn(document, 'createElement')
            .mockImplementation((tagName: string) => (
                tagName === 'canvas'
                    ? {
                        width: 0,
                        height: 0,
                        getContext: () => ({ drawImage }),
                        toBlob,
                    } as unknown as HTMLCanvasElement
                    : originalCreateElement(tagName)
            ));

        const stalled = renderSvgToPng('<svg/>');
        const timedOut = expect(stalled).rejects.toThrow('Image rendering timed out.');
        await vi.advanceTimersByTimeAsync(10_000);
        await timedOut;
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:share-card');
        expect(images[0]?.onload).toBeNull();

        const stalledEncode = renderSvgToPng('<svg/>');
        const encodeTimedOut = expect(stalledEncode).rejects.toThrow('Image rendering timed out.');
        images[1]?.onload?.();
        await vi.advanceTimersByTimeAsync(10_000);
        await encodeTimedOut;
        expect(images[1]?.onload).toBeNull();
        lateEncode?.(new Blob(['late'], { type: 'image/png' }));

        const recovered = renderSvgToPng('<svg/>');
        images[2]?.onload?.();
        await expect(recovered).resolves.toEqual(expect.objectContaining({ type: 'image/png' }));
        expect(drawImage).toHaveBeenCalledTimes(2);
        createElement.mockRestore();
    });

    it("downloads a generic PNG filename in the browser and records metadata only", async () => {
        const saved = await saveShareCardPng(
            new Blob(["png"], { type: "image/png" }),
            'review',
            "Save image…",
        );

        expect(saved).toBe(true);
        expect(click).toHaveBeenCalledTimes(1);
        expect(clickedDownload).toBe('mindwtr-review.png');
        expect(createObjectUrl).toHaveBeenCalledTimes(1);
        expect(revokeObjectUrl).toHaveBeenCalledWith("blob:share-card");
        expect(mocks.logInfo).toHaveBeenCalledWith("Share card exported", {
            scope: "share-card",
            extra: {
                releaseCheck: "v1.3.0/share-card-export",
                kind: 'review',
                operation: "save",
            },
        });
    });

    it('writes the PNG bytes to the path selected in Tauri', async () => {
        mocks.isTauriRuntime.mockReturnValue(true);
        mocks.save.mockResolvedValue('/chosen/mindwtr-review.png');
        const bytes = new Uint8Array([137, 80, 78, 71]);
        const png = {
            arrayBuffer: vi.fn(async () => bytes.buffer),
        } as unknown as Blob;

        const saved = await saveShareCardPng(png, 'review', 'Save image…');

        expect(saved).toBe(true);
        expect(mocks.save).toHaveBeenCalledWith({
            defaultPath: 'mindwtr-review.png',
            filters: [{ name: 'PNG', extensions: ['png'] }],
            title: 'Save image…',
        });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/chosen/mindwtr-review.png',
            bytes,
        );
        expect(mocks.logInfo).toHaveBeenCalledWith('Share card exported', expect.objectContaining({
            extra: expect.objectContaining({ operation: 'save', kind: 'review' }),
        }));
    });

    it("treats a dismissed Tauri save dialog as a quiet cancellation", async () => {
        mocks.isTauriRuntime.mockReturnValue(true);
        mocks.save.mockResolvedValue(null);

        const saved = await saveShareCardPng(
            new Blob(["png"], { type: "image/png" }),
            'review',
            "Save image…",
        );

        expect(saved).toBe(false);
        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(mocks.logInfo).not.toHaveBeenCalled();
    });
});
