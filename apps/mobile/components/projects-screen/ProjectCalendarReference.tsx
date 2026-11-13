import React, { useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PROJECT_CALENDAR_REFERENCE_PICKER_LIMIT, safeFormatDate, safeParseDate, type Project } from '@mindwtr/core';
import { useThemeColors } from '../../hooks/use-theme-colors';
import { useProjectCalendarReference } from './use-project-calendar-reference';

export function ProjectCalendarReference({ project, readOnly, t }: {
    project: Project; readOnly: boolean; t: (key: string) => string;
}) {
    const tc = useThemeColors();
    const calendar = useProjectCalendarReference(project, readOnly);
    const { reference, resolved, pickerOpen, saving, saveError, choices, load } = calendar;
    const [search, setSearch] = useState('');
    const query = search.trim().toLocaleLowerCase();
    const matches = choices.filter(event => `${event.title} ${event.sourceName}`.toLocaleLowerCase().includes(query));
    const visibleChoices = matches.slice(0, PROJECT_CALENDAR_REFERENCE_PICKER_LIMIT);
    const details = resolved?.event ?? reference;
    const disabled = readOnly || project.status === 'archived' || saving;
    const dateText = (event: { start: string; end: string; allDay: boolean }) => {
        const start = safeFormatDate(event.start, event.allDay ? 'PP' : 'PPp');
        const lastDay = safeParseDate(event.end);
        if (!lastDay) return start;
        if (event.allDay) lastDay.setDate(lastDay.getDate() - 1);
        const end = safeFormatDate(lastDay, event.allDay ? 'PP' : 'PPp');
        return start === end ? start : `${start} – ${end}`;
    };
    const buttonStyle = { minHeight: 44, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: tc.border, opacity: disabled ? 0.5 : 1 };
    return <View testID="project-calendar-reference" style={{ marginVertical: 8, padding: 12, gap: 8, borderRadius: 10, borderWidth: 1, borderColor: tc.border, backgroundColor: tc.cardBg }}>
        {reference && details && <>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <Ionicons name="calendar-outline" size={18} color={tc.icon} />
                <Text accessibilityRole="header" style={{ color: tc.text, fontWeight: '600' }}>{t('projects.calendarTitle')}</Text>
            </View>
            <Text style={{ color: tc.secondaryText, fontSize: 12 }}>{t('projects.calendarScheduled')}</Text>
            <Text style={{ color: tc.text }}>{details.title}</Text>
            <Text style={{ color: tc.secondaryText, fontSize: 12 }}>{dateText(details)} · {reference.sourceName}</Text>
            {resolved?.status === 'elapsed' && <Text style={{ color: tc.secondaryText, fontSize: 12 }}>{t('projects.calendarElapsed')}</Text>}
            {resolved?.status === 'unavailable' && <Text style={{ color: tc.secondaryText, fontSize: 12 }}>{t(load.status === 'idle' || load.status === 'loading' ? 'projects.calendarLastKnown' : 'projects.calendarUnavailable')}</Text>}
        </>}
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled, expanded: pickerOpen }} disabled={disabled}
            testID="project-calendar-link" style={buttonStyle} onPress={() => calendar.setPickerOpen(!pickerOpen)}>
            <Text style={{ color: tc.tint }}>{t(reference ? 'projects.calendarReplace' : 'projects.calendarLink')}</Text>
        </TouchableOpacity>
        {reference && <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
            testID="project-calendar-unlink" style={buttonStyle} onPress={() => { void calendar.save(null); }}>
            <Text style={{ color: tc.tint }}>{t('projects.calendarUnlink')}</Text>
        </TouchableOpacity>}
        {pickerOpen && <View style={{ gap: 8 }}>
            <Text style={{ color: tc.secondaryText, fontSize: 12 }}>{t('projects.calendarHelp')}</Text>
            <Text style={{ color: tc.text, fontSize: 12 }}>{t('projects.calendarWindow')}</Text>
            <TextInput value={search} onChangeText={setSearch} accessibilityLabel={t('common.search')} placeholder={t('common.search')}
                placeholderTextColor={tc.secondaryText} style={{ minHeight: 44, paddingHorizontal: 10, color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border, borderWidth: 1, borderRadius: 8 }} />
            {matches.length > PROJECT_CALENDAR_REFERENCE_PICKER_LIMIT && <Text style={{ color: tc.secondaryText, fontSize: 12 }}>{t('projects.calendarLimit')}</Text>}
            {load.status === 'loading' && <Text style={{ color: tc.secondaryText }}>{t('common.loading')}</Text>}
            {(load.status === 'error' || (load.status === 'ready' && !load.available)) && <Text accessibilityLiveRegion="polite" style={{ color: tc.secondaryText }}>{t('projects.calendarLoadFailed')}</Text>}
            {load.status === 'ready' && load.available && matches.length === 0 && <Text style={{ color: tc.secondaryText }}>{t(query ? 'common.noMatches' : 'projects.calendarEmpty')}</Text>}
            {visibleChoices.length > 0 && <ScrollView nestedScrollEnabled style={{ maxHeight: 260 }}>
                {visibleChoices.map((event, index) => <TouchableOpacity accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }}
                    key={`${event.sourceId}/${event.uid}/${event.recurrenceId ?? ''}/${index}`} testID={`project-calendar-event-${index}`}
                    style={{ paddingVertical: 12, opacity: disabled ? 0.5 : 1 }} onPress={() => { void calendar.save(event); }}>
                    <Text style={{ color: tc.text }}>{event.title}</Text>
                    <Text style={{ color: tc.secondaryText, fontSize: 12 }}>{dateText(event)} · {event.sourceName}</Text>
                </TouchableOpacity>)}
            </ScrollView>}
            <TouchableOpacity accessibilityRole="button" disabled={saving} accessibilityState={{ disabled: saving }} style={buttonStyle} onPress={() => calendar.setPickerOpen(false)}>
                <Text style={{ color: tc.text }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
        </View>}
        {saveError && <Text accessibilityRole="alert" style={{ color: tc.danger }}>{t('projects.calendarSaveFailed')}</Text>}
    </View>;
}
