import { getProjectSectionsForView, type Project, type Section } from '@mindwtr/core';

import { SectionSelector } from './ui/SectionSelector';

type InboxProcessingSectionFieldProps = {
    t: (key: string) => string;
    project: Project | null | undefined;
    sections: readonly Section[];
    value: string;
    onChange: (sectionId: string) => void;
    onCreateSection: (title: string) => Promise<string | null>;
    controlClassName?: string;
    labelClassName?: string;
};

/**
 * The task editor's Section picker for Inbox processing: shown only once the
 * chosen project has sections (#1461). The draft clears the section when the
 * project changes, so a stale section can never ride along.
 */
export function InboxProcessingSectionField({
    t,
    project,
    sections,
    value,
    onChange,
    onCreateSection,
    controlClassName = 'bg-card rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none',
    labelClassName = 'text-xs text-muted-foreground font-medium',
}: InboxProcessingSectionFieldProps) {
    const projectSections = getProjectSectionsForView(project, sections);
    if (projectSections.length === 0) return null;
    return (
        <div className="space-y-1">
            <label className={labelClassName}>{t('taskEdit.sectionLabel')}</label>
            <SectionSelector
                sections={projectSections}
                value={value}
                onChange={onChange}
                onCreateSection={onCreateSection}
                ariaLabel={t('taskEdit.sectionLabel')}
                placeholder={t('taskEdit.noSectionOption')}
                noSectionLabel={t('taskEdit.noSectionOption')}
                searchPlaceholder={t('sections.search')}
                noMatchesLabel={t('common.noMatches')}
                createSectionLabel={t('projects.addSection')}
                className="w-full"
                controlClassName={controlClassName}
            />
        </div>
    );
}
