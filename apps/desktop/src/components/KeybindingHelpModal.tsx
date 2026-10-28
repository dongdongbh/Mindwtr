import { useId } from 'react';
import { resolveFeatureFlags, useTaskStore } from '@mindwtr/core';
import { KeybindingStyle } from '../contexts/keybinding-context';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from './ui/Dialog';
import { useAppLockStore } from '../lib/app-lock';
import {
    type GlobalQuickAddShortcutSetting,
    formatGlobalQuickAddShortcutForDisplay,
} from '../lib/global-quick-add-shortcut';

interface KeybindingHelpModalProps {
    style: KeybindingStyle;
    onClose: () => void;
    currentView: string;
    quickAddShortcut: GlobalQuickAddShortcutSetting;
    t: (key: string) => string;
}

type HelpItem = {
    keys: string;
    labelKey: string;
    fallbackLabel?: string;
};

export function KeybindingHelpModal({
    style,
    onClose,
    currentView,
    quickAddShortcut,
    t,
}: KeybindingHelpModalProps) {
    const titleId = useId();
    const prioritiesEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).priorities);
    const timelineEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).timeline);
    const appLockEnabled = useAppLockStore((state) => state.enabled);
    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
    const primary = isMac ? 'Cmd' : 'Ctrl';
    const quickAddShortcutDisplay = formatGlobalQuickAddShortcutForDisplay(quickAddShortcut, isMac, t);
    const sharedGlobal: HelpItem[] = [
        { keys: quickAddShortcutDisplay, labelKey: 'keybindings.globalQuickAdd', fallbackLabel: 'Global quick add' },
        { keys: 'a', labelKey: 'keybindings.inAppQuickAdd', fallbackLabel: 'In-app quick add' },
        { keys: isMac ? 'Cmd+Option+S' : 'Ctrl+Alt+S', labelKey: 'settings.syncNow', fallbackLabel: 'Sync now' },
        { keys: `${primary}+,`, labelKey: 'keybindings.openSettings' },
        { keys: `${primary}+B / ${primary}+\\`, labelKey: 'keybindings.toggleSidebar' },
        { keys: `${primary}+Shift+\\`, labelKey: 'keybindings.toggleFocusMode' },
        { keys: `${primary}+Shift+D`, labelKey: 'keybindings.list.toggleDetails' },
        { keys: `${primary}+Shift+C`, labelKey: 'keybindings.list.toggleDensity' },
        { keys: `${primary}+Z`, labelKey: 'keybindings.undo', fallbackLabel: 'Undo last complete/delete' },
        { keys: 'F11', labelKey: 'keybindings.toggleFullscreen' },
        ...(appLockEnabled ? [{ keys: `${primary}+Shift+L`, labelKey: 'appLock.lockNow' }] : []),
    ];
    const vimGlobal: HelpItem[] = [
        ...sharedGlobal,
        { keys: '/', labelKey: 'keybindings.openSearch' },
        { keys: '?', labelKey: 'keybindings.openHelp' },
        { keys: 'h / ←', labelKey: 'keybindings.focusSidebar' },
        { keys: 'l / →', labelKey: 'keybindings.focusContent' },
        { keys: 'gi', labelKey: 'keybindings.goInbox' },
        { keys: 'gn', labelKey: 'keybindings.goNext' },
        { keys: 'gf', labelKey: 'keybindings.goAgenda' },
        { keys: 'gp', labelKey: 'keybindings.goProjects' },
        { keys: 'gc', labelKey: 'keybindings.goContexts' },
        { keys: 'gr', labelKey: 'keybindings.goReview' },
        { keys: 'gw', labelKey: 'keybindings.goWaiting' },
        { keys: 'gs', labelKey: 'keybindings.goSomeday' },
        { keys: 'ge', labelKey: 'keybindings.goReference' },
        { keys: 'gl', labelKey: 'keybindings.goCalendar' },
        { keys: 'gb', labelKey: 'keybindings.goBoard' },
        ...(timelineEnabled ? [{ keys: 'gt', labelKey: 'keybindings.goTimeline' }] : []),
        { keys: 'gd', labelKey: 'keybindings.goDone' },
        { keys: 'ga', labelKey: 'keybindings.goArchived' },
        { keys: 'gT', labelKey: 'keybindings.goTrash', fallbackLabel: 'Go to Trash' },
        { keys: '1-9 / Shift+A 1-9', labelKey: 'keybindings.switchArea', fallbackLabel: 'Switch to Area 1-9' },
        { keys: '0 / Shift+A 0', labelKey: 'keybindings.clearAreaFilter', fallbackLabel: 'Clear area filter' },
    ];

    const vimList: HelpItem[] = [
        { keys: 'j / k / ↑ / ↓', labelKey: 'keybindings.list.nextPrev' },
        { keys: 'gg / G', labelKey: 'keybindings.list.firstLast' },
        { keys: 'Enter', labelKey: 'keybindings.list.open', fallbackLabel: 'Open selected task' },
        { keys: 'e', labelKey: 'keybindings.list.edit' },
        { keys: '.', labelKey: 'taskEdit.moreOptions' },
        { keys: `${primary}+Enter`, labelKey: 'keybindings.list.saveEdit' },
        { keys: 'Esc', labelKey: 'keybindings.list.cancelEdit' },
        { keys: 'x', labelKey: 'keybindings.list.toggleDone' },
        { keys: 'dd', labelKey: 'keybindings.list.delete' },
        { keys: 'yy', labelKey: 'keybindings.list.copyTitle' },
        { keys: 'yi', labelKey: 'keybindings.list.copyWithDescription' },
        { keys: 'si / sn / sw / ss / sd / sa', labelKey: 'keybindings.list.setStatus', fallbackLabel: 'Set status: Inbox / Next / Waiting / Someday / Done / Archived' },
        { keys: 'Insert', labelKey: 'keybindings.list.newTask', fallbackLabel: 'Focus add-task input' },
    ];

    const standardList: HelpItem[] = [
        { keys: 'j / k / ↑ / ↓', labelKey: 'keybindings.list.nextPrev' },
        { keys: 'gg / G', labelKey: 'keybindings.list.firstLast' },
        { keys: 'Enter', labelKey: 'keybindings.list.open', fallbackLabel: 'Open selected task' },
        { keys: 'Shift+Enter', labelKey: 'keybindings.list.edit' },
        { keys: 'e', labelKey: 'keybindings.list.toggleDone' },
        { keys: 'x', labelKey: 'keybindings.list.select', fallbackLabel: 'Select / deselect task' },
        { keys: 'S', labelKey: 'agenda.addToFocus', fallbackLabel: "Add to today's focus" },
        { keys: 'F2', labelKey: 'task.renameTitle', fallbackLabel: 'Rename task' },
        { keys: '#', labelKey: 'keybindings.list.delete' },
        { keys: 'z', labelKey: 'keybindings.undo', fallbackLabel: 'Undo last complete/delete' },
        { keys: '.', labelKey: 'taskEdit.moreOptions' },
        { keys: `${primary}+Enter`, labelKey: 'keybindings.list.saveEdit' },
        { keys: 'Esc', labelKey: 'keybindings.list.cancelEdit' },
        { keys: 'si / sn / sw / ss / sd / sa', labelKey: 'keybindings.list.setStatus', fallbackLabel: 'Set status: Inbox / Next / Waiting / Someday / Done / Archived' },
        { keys: 'Insert', labelKey: 'keybindings.list.newTask', fallbackLabel: 'Focus add-task input' },
    ];

    const emacsGlobal: HelpItem[] = [
        ...sharedGlobal,
        { keys: 'Ctrl+S', labelKey: 'keybindings.openSearch' },
        { keys: 'Ctrl+H / Ctrl+?', labelKey: 'keybindings.openHelp' },
        { keys: 'Alt+I', labelKey: 'keybindings.goInbox' },
        { keys: 'Alt+N', labelKey: 'keybindings.goNext' },
        { keys: 'Alt+A', labelKey: 'keybindings.goAgenda' },
        { keys: 'Alt+P', labelKey: 'keybindings.goProjects' },
        { keys: 'Alt+C', labelKey: 'keybindings.goContexts' },
        { keys: 'Alt+R', labelKey: 'keybindings.goReview' },
        { keys: 'Alt+W', labelKey: 'keybindings.goWaiting' },
        { keys: 'Alt+S', labelKey: 'keybindings.goSomeday' },
        { keys: 'Alt+E', labelKey: 'keybindings.goReference' },
        { keys: 'Alt+L', labelKey: 'keybindings.goCalendar' },
        { keys: 'Alt+B', labelKey: 'keybindings.goBoard' },
        ...(timelineEnabled ? [{ keys: 'Alt+T', labelKey: 'keybindings.goTimeline' }] : []),
        { keys: 'Alt+D', labelKey: 'keybindings.goDone' },
        { keys: 'Alt+Shift+A', labelKey: 'keybindings.goArchived' },
        { keys: 'Alt+Shift+T', labelKey: 'keybindings.goTrash', fallbackLabel: 'Go to Trash' },
        { keys: '1-9 / Shift+A 1-9', labelKey: 'keybindings.switchArea', fallbackLabel: 'Switch to Area 1-9' },
        { keys: '0 / Shift+A 0', labelKey: 'keybindings.clearAreaFilter', fallbackLabel: 'Clear area filter' },
    ];

    const emacsList: HelpItem[] = [
        { keys: 'Ctrl+N / Ctrl+P / ↑ / ↓', labelKey: 'keybindings.list.nextPrev' },
        { keys: 'Enter', labelKey: 'keybindings.list.open', fallbackLabel: 'Open selected task' },
        { keys: 'Ctrl+E', labelKey: 'keybindings.list.edit' },
        { keys: 'Ctrl+.', labelKey: 'taskEdit.moreOptions' },
        { keys: `${primary}+Enter`, labelKey: 'keybindings.list.saveEdit' },
        { keys: 'Esc', labelKey: 'keybindings.list.cancelEdit' },
        { keys: 'Ctrl+T', labelKey: 'keybindings.list.toggleDone' },
        { keys: 'Ctrl+D', labelKey: 'keybindings.list.delete' },
        { keys: 'si / sn / sw / ss / sd / sa', labelKey: 'keybindings.list.setStatus', fallbackLabel: 'Set status: Inbox / Next / Waiting / Someday / Done / Archived' },
        { keys: 'Insert', labelKey: 'keybindings.list.newTask', fallbackLabel: 'Focus add-task input' },
    ];

    // Keep this table in sync with the parser inventory mirrored by
    // SLASH_COMMANDS in TaskInput.tsx (#869) and the quickAdd.help string.
    const quickAddSyntax: HelpItem[] = [
        { keys: '/start:<when>', labelKey: 'taskEdit.startDateLabel' },
        { keys: '/due:<when>', labelKey: 'taskEdit.dueDateLabel' },
        { keys: '/review:<when>', labelKey: 'taskEdit.reviewDateLabel' },
        { keys: '/note:<text>', labelKey: 'taskEdit.descriptionLabel' },
        { keys: '/link:<url>', labelKey: 'attachments.addLink' },
        { keys: '/energy:<level>', labelKey: 'taskEdit.energyLevel' },
        // The parser drops /priority: while the Priorities feature is off, so the
        // help table must not advertise it (#1107).
        ...(prioritiesEnabled
            ? [{ keys: '/priority:<level>', labelKey: 'taskEdit.priorityLabel' }]
            : []),
        { keys: '/inbox /next /waiting /someday /reference /done /archived', labelKey: 'taskEdit.statusLabel' },
        { keys: '/*', labelKey: 'agenda.addToFocus', fallbackLabel: "Add to today's focus" },
        { keys: '/area:<name> or !Area', labelKey: 'taskEdit.areaLabel' },
        { keys: '@context', labelKey: 'taskEdit.contextsLabel' },
        { keys: '#tag', labelKey: 'taskEdit.tagsLabel' },
        { keys: '+Project', labelKey: 'taskEdit.projectLabel' },
        { keys: '%Person or %"Full Name"', labelKey: 'taskEdit.assignedTo' },
    ];

    const globalItems = style === 'emacs' ? emacsGlobal : vimGlobal;
    const listItems: HelpItem[] = [
        { keys: `${primary}+C`, labelKey: 'keybindings.list.copyTitle' },
        { keys: `${primary}+Click / Shift+Click`, labelKey: 'keybindings.list.select' },
        ...(style === 'emacs' ? emacsList : style === 'standard' ? standardList : vimList),
    ];
    const resolveItemLabel = (item: HelpItem) => {
        const translated = t(item.labelKey);
        if (translated !== item.labelKey) return translated;
        return item.fallbackLabel ?? translated;
    };

    return (
        <Dialog
            onClose={onClose}
            labelledBy={titleId}
            panelClassName="max-w-2xl mx-4 max-h-[80vh] bg-card rounded-lg border-border shadow-xl"
        >
            <DialogHeader className="p-6 border-b border-border flex items-center justify-between">
                <div>
                    <h3 id={titleId} className="text-xl font-semibold">{t('keybindings.helpTitle')}</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                        {t('keybindings.helpSubtitle')}
                    </p>
                </div>
                <div className="text-sm text-muted-foreground">
                    {t('keybindings.styleLabel')}: <span className="font-medium text-foreground">{t(`keybindings.style.${style}`)}</span>
                </div>
            </DialogHeader>

            <DialogBody className="p-6 flex-1 space-y-6">
                <div>
                    <h4 className="font-medium mb-3">{t('keybindings.section.global')}</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {globalItems.map((item, index) => (
                            <div key={`${item.labelKey}-${index}`} className="flex items-center justify-between bg-muted/30 rounded-md px-3 py-2">
                                <code className="text-xs bg-muted px-2 py-0.5 rounded">{item.keys}</code>
                                <span className="text-sm">{resolveItemLabel(item)}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <div>
                    <h4 className="font-medium mb-3">{t('keybindings.section.taskList')}</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {listItems.map((item) => (
                            <div key={item.keys} className="flex items-center justify-between bg-muted/30 rounded-md px-3 py-2">
                                <code className="text-xs bg-muted px-2 py-0.5 rounded">{item.keys}</code>
                                <span className="text-sm">{resolveItemLabel(item)}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <div>
                    <h4 className="font-medium mb-3">{t('keybindings.section.quickAddSyntax')}</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {quickAddSyntax.map((item) => (
                            <div key={item.keys} className="flex items-center justify-between gap-3 bg-muted/30 rounded-md px-3 py-2">
                                <code className="text-xs bg-muted px-2 py-0.5 rounded whitespace-nowrap overflow-x-auto">{item.keys}</code>
                                <span className="text-sm text-right shrink-0">{resolveItemLabel(item)}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <p className="text-xs text-muted-foreground">
                    {t('nav.settings')}: {t('keybindings.styleLabel')} • {t('keybindings.style.standard')} / {t('keybindings.style.vim')} / {t('keybindings.style.emacs')} ({currentView})
                </p>
            </DialogBody>

            <DialogFooter className="p-4 border-t border-border flex justify-end">
                <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 rounded-md text-sm font-medium bg-muted hover:bg-muted/80 transition-colors"
                >
                    Esc
                </button>
            </DialogFooter>
        </Dialog>
    );
}
