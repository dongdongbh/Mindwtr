import type { AppAnnouncement, AppAnnouncementAction } from '@mindwtr/core';
import { AppAnnouncementModal } from './AppAnnouncementModal';


export type StartupPromptPresentation = {
    id: string;
    announcement: AppAnnouncement | null;
    onAction: (action: AppAnnouncementAction) => void;
    onDismiss: () => void;
    onShown?: () => void;
};

type StartupPromptModalProps = {

    openId: string | null;

    blocked: boolean;
    prompts: StartupPromptPresentation[];
};

const noop = () => {};

export function StartupPromptModal({ openId, blocked, prompts }: StartupPromptModalProps) {
    const active = prompts.find((prompt) => prompt.id === openId) ?? null;
    return (
        <AppAnnouncementModal
            announcement={active?.announcement ?? null}
            isOpen={active !== null && !blocked}
            onAction={active?.onAction ?? noop}
            onDismiss={active?.onDismiss ?? noop}
            onShown={active?.onShown}
        />
    );
}
