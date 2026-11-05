import { sendDesktopImmediateNotification } from './notification-service';
import { isTauriRuntime } from './runtime';

type AudioContextLike = {
    currentTime: number;
    destination: AudioNode;
    state?: string;
    resume?: () => Promise<void>;
    createGain: () => GainNode;
    createOscillator: () => OscillatorNode;
};

type AudioContextConstructorLike = new () => AudioContextLike;

const getAudioContextConstructor = (): AudioContextConstructorLike | undefined => {
    const audioGlobal = globalThis as typeof globalThis & {
        AudioContext?: AudioContextConstructorLike;
        webkitAudioContext?: AudioContextConstructorLike;
    };
    return audioGlobal.AudioContext ?? audioGlobal.webkitAudioContext;
};


let armedAudioContext: AudioContextLike | null = null;

export function armPomodoroCompletionSound(): void {
    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) return;
    try {
        if (armedAudioContext && armedAudioContext.state !== 'closed') {
            if (armedAudioContext.state === 'suspended') void armedAudioContext.resume?.();
            return;
        }
        const context = new AudioContextConstructor();
        if (context.state === 'suspended') void context.resume?.();
        armedAudioContext = context;
    } catch {

    }
}

export async function playPomodoroCompletionSound(): Promise<void> {
    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) return;

    try {
        const armed = armedAudioContext && armedAudioContext.state === 'running'
            ? armedAudioContext
            : null;
        const context = armed ?? new AudioContextConstructor();
        if (context.state === 'suspended' && context.resume) {
            await context.resume();
        }

        const now = context.currentTime;
        const gain = context.createGain();
        gain.connect(context.destination);
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.16, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

        [880, 1174].forEach((frequency, index) => {
            const oscillator = context.createOscillator();
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, now + index * 0.12);
            oscillator.connect(gain);
            oscillator.start(now + index * 0.12);
            oscillator.stop(now + 0.5 + index * 0.12);
        });
    } catch {

    }
}

export async function requestPomodoroWindowAttention(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        if (await currentWindow.isFocused()) return;


        await currentWindow.requestUserAttention(UserAttentionType.Critical);
    } catch {

    }
}

export async function sendDesktopPomodoroCompletionAlert(title: string, body: string): Promise<void> {
    void playPomodoroCompletionSound();
    void requestPomodoroWindowAttention();
    await sendDesktopImmediateNotification(title, body);
}
