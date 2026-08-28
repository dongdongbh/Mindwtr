import { useState } from 'react';
import { sortViewSectionDefinitions, tFallback, type ViewSectionDefinition } from '@mindwtr/core';

import { reportError } from '../../lib/report-error';
import { PromptModal } from '../PromptModal';

export const NEW_SOMEDAY_SECTION_VALUE = '__new-someday-section__';

type SomedaySectionSelectorProps = {
    sections: readonly ViewSectionDefinition[];
    value?: string;
    onChange: (sectionId: string | undefined) => void;
    onCreateSection: (title: string) => Promise<string | null>;
    t: (key: string) => string;
    id?: string;
    className?: string;
};

export function SomedaySectionSelector({
    sections,
    value,
    onChange,
    onCreateSection,
    t,
    id,
    className,
}: SomedaySectionSelectorProps) {
    const [createOpen, setCreateOpen] = useState(false);
    const sortedSections = sortViewSectionDefinitions(sections);
    const selectedValue = sortedSections.some((section) => section.id === value) ? value : '';

    return (
        <>
            <select
                id={id}
                aria-label={tFallback(t, 'viewSections.somedaySection', 'Someday section')}
                value={selectedValue}
                onChange={(event) => {
                    if (event.target.value === NEW_SOMEDAY_SECTION_VALUE) {
                        setCreateOpen(true);
                        return;
                    }
                    onChange(event.target.value || undefined);
                }}
                className={className}
            >
                <option value="">{tFallback(t, 'viewSections.noSection', 'No section')}</option>
                {sortedSections.map((section) => (
                    <option key={section.id} value={section.id}>{section.title}</option>
                ))}
                <option value={NEW_SOMEDAY_SECTION_VALUE}>
                    + {tFallback(t, 'viewSections.add', 'New section…')}
                </option>
            </select>
            {createOpen && <PromptModal
                isOpen={createOpen}
                title={tFallback(t, 'viewSections.add', 'New section…')}
                description={tFallback(t, 'viewSections.nameHint', 'Section name')}
                placeholder={tFallback(t, 'viewSections.namePlaceholder', 'Books to read')}
                confirmLabel={t('common.save')}
                cancelLabel={t('common.cancel')}
                onCancel={() => setCreateOpen(false)}
                onConfirm={(title) => {
                    setCreateOpen(false);
                    void onCreateSection(title)
                        .then((sectionId) => {
                            if (sectionId) onChange(sectionId);
                        })
                        .catch((error) => reportError('Failed to create Someday section', error));
                }}
            />}
        </>
    );
}
