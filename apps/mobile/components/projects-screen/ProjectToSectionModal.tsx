import React from 'react';
import { Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
    createProjectToSectionPreviewer,
    formatI18nTemplate,
    prepareProjectToSection,
    tFallback,
    useTaskStore,
    type PreparedProjectToSection,
    type Project,
    type ProjectToSectionPreview,
    type ProjectToSectionReceipt,
} from '@mindwtr/core';
import { useThemeColors } from '../../hooks/use-theme-colors';
import { useLanguage } from '../../contexts/language-context';
import { projectsScreenStyles as styles } from './projects-screen.styles';

export function ProjectToSectionModal({ visible, source, projects, onClose, onSuccess }: {
    visible: boolean;
    source: Project | null;
    projects: Project[];
    onClose: () => void;
    onSuccess: (result: { destinationProjectId: string; receipt: ProjectToSectionReceipt }) => void;
}) {
    const { t } = useLanguage();
    const tc = useThemeColors();
    const [destinationId, setDestinationId] = React.useState('');
    const [name, setName] = React.useState('');
    const [prepared, setPrepared] = React.useState<PreparedProjectToSection | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [retryOnly, setRetryOnly] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const resetSourceId = React.useRef<string | null | undefined>(undefined);
    React.useEffect(() => {
        if (!visible) { resetSourceId.current = undefined; return; }
        const sourceId = source?.id ?? null;
        if (resetSourceId.current === sourceId) return;
        resetSourceId.current = sourceId;
        setDestinationId('');
        setName(source?.title ?? '');
        setPrepared(null);
        setRetryOnly(false);
        setError(null);
    }, [visible, source?.id, source?.title]);
    // Typing the section name re-renders; rebuild the destination list only when its inputs change.
    const { _allProjects, _allSections, _allTasks } = useTaskStore.getState();
    const sourceId = source?.id;
    const previewDestination = React.useMemo(() => sourceId
        ? createProjectToSectionPreviewer({ _allProjects, _allSections, _allTasks }, sourceId)
        : null, [_allProjects, _allSections, _allTasks, sourceId]);
    const destinations = React.useMemo(() => previewDestination
        ? projects.filter((project) => previewDestination(project.id).ok)
        : [], [projects, previewDestination]);
    const preview = previewDestination && destinationId ? previewDestination(destinationId) : null;
    const shownPreview: ProjectToSectionPreview | null = prepared?.preview ?? (preview?.ok ? preview : null);
    const destination = prepared?.destination ?? projects.find((project) => project.id === destinationId);
    const sourceForSummary = prepared?.source.before ?? source;
    const destinationArea = destination?.areaId
        ? useTaskStore.getState().areas.find((area) => area.id === destination.areaId)
        : undefined;
    const blocked = (reason: string) => tFallback(t, `projects.convertBlocked.${reason}`, reason);
    const confirm = () => {
        if (!source) return;
        const next = prepareProjectToSection(useTaskStore.getState(), source.id, destinationId, name);
        if (!next.ok) { setError(blocked(next.reason)); return; }
        setPrepared(next.command);
        setError(null);
    };
    const save = async () => {
        if (!prepared || busy) return;
        setBusy(true);
        setError(null);
        try {
            const result = await useTaskStore.getState().convertProjectToSection(prepared);
            if (result.success) { onSuccess(result); return; }
            setError(tFallback(t, `projects.convertFailure.${result.reason}`, result.reason));
            if (result.reason === 'save-failed') setRetryOnly(true);
            else setPrepared(null);
        } catch {
            setError(tFallback(t, 'projects.convertFailure.save-failed', 'Could not save. Retry the same conversion.'));
            setRetryOnly(true);
        } finally { setBusy(false); }
    };
    const button = (label: string, onPress: () => void, disabled = false) => <TouchableOpacity
        accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
        onPress={onPress} style={[styles.linkModalButton, disabled ? { opacity: 0.5 } : null]}>
        <Text style={[styles.linkModalButtonText, { color: tc.text }]}>{label}</Text>
    </TouchableOpacity>;
    return <Modal visible={visible} transparent animationType="fade" accessibilityViewIsModal onRequestClose={() => { if (!busy && !retryOnly) onClose(); }}>
        <View style={styles.overlay}>
            <View style={[styles.linkModalCard, { backgroundColor: tc.cardBg, borderColor: tc.border, maxHeight: '85%' }]}>
                <Text accessibilityRole="header" style={[styles.linkModalTitle, { color: tc.text }]}>{tFallback(t, 'projects.convertToSection', 'Convert to section…')}</Text>
                <ScrollView keyboardShouldPersistTaps="handled">
                    {sourceForSummary?.isSequential && <Text style={{ color: tc.secondaryText }}>{tFallback(t, 'projects.convertBlocked.destination-section-sequence', 'Choose a destination set to Sequential → Within sections. The new section keeps its task sequence; other sections keep progressing independently.')}</Text>}
                    {!prepared ? <>
                        <Text style={{ color: tc.text, marginBottom: 8 }}>{tFallback(t, 'projects.convertDestination', 'Destination project')}</Text>
                        {destinations.map((project) =>
                            <TouchableOpacity key={project.id} accessibilityRole="radio" accessibilityState={{ selected: destinationId === project.id }} onPress={() => { setDestinationId(project.id); setError(null); }} style={{ paddingVertical: 10 }}>
                                <Text style={{ color: destinationId === project.id ? tc.tint : tc.text }}>{project.title}</Text>
                            </TouchableOpacity>)}
                        <Text style={{ color: tc.text, marginTop: 12 }}>{tFallback(t, 'projects.convertSectionName', 'Section name')}</Text>
                        <TextInput value={name} onChangeText={(value) => { setName(value); setError(null); }} editable={!busy}
                            accessibilityLabel={tFallback(t, 'projects.convertSectionName', 'Section name')}
                            style={[styles.linkModalInput, { color: tc.text, borderColor: tc.border, backgroundColor: tc.inputBg }]} />
                    </> : null}
                    {shownPreview && <View style={{ gap: 8, paddingVertical: 12 }}>
                        <Text style={{ color: tc.text }}>{formatI18nTemplate(tFallback(t, 'projects.convertSummary', 'Move {{count}} tasks ({{completed}} done, {{archived}} archived) from {{source}} into {{destination}}.'), {
                            count: shownPreview.taskCount, completed: shownPreview.completedCount, archived: shownPreview.archivedCount,
                            source: shownPreview.sourceTitle, destination: shownPreview.destinationTitle,
                        })}</Text>
                        {prepared && <Text style={{ color: tc.text }}>{formatI18nTemplate(tFallback(t, 'projects.convertNamedSection', 'New section: {{name}}'), { name: prepared.section.title })}</Text>}
                        {sourceForSummary?.supportNotes ? <Text style={{ color: tc.secondaryText }}>{tFallback(t, 'projects.convertNotes', 'Project notes become section notes.')}</Text> : null}
                        <Text style={{ color: tc.secondaryText }}>{formatI18nTemplate(tFallback(t, 'projects.convertArea', 'Moved tasks use the destination Area: {{area}}.'), { area: destinationArea?.name ?? tFallback(t, 'projects.noArea', 'No Area') })}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: destinationArea?.color ?? destination?.color, borderColor: tc.border, borderWidth: 1 }} /><Text style={{ color: tc.secondaryText }}>{tFallback(t, 'projects.convertDestinationColor', 'Section follows the destination color.')}</Text></View>
                        <Text style={{ color: tc.secondaryText }}>{tFallback(t, 'projects.convertColor', 'The source project color is not carried to the section.')}</Text>
                        <Text style={{ color: tc.secondaryText }}>{tFallback(t, 'projects.convertSettings', 'The new section uses the destination project’s settings.')}</Text>
                        <Text style={{ color: tc.secondaryText }}>{tFallback(t, 'projects.convertTrash', 'The source project moves to Trash. Already-deleted tasks stay in Trash.')}</Text>
                    </View>}
                    {preview && !preview.ok && <Text accessibilityRole="alert" style={{ color: tc.danger }}>{blocked(preview.reason)}</Text>}
                    {error && <Text accessibilityRole="alert" style={{ color: tc.danger }}>{error}</Text>}
                </ScrollView>
                <View style={styles.linkModalButtons}>
                    {button(prepared ? tFallback(t, 'common.back', 'Back') : t('common.cancel'), prepared ? () => { setPrepared(null); setError(null); } : onClose, busy || retryOnly)}
                    {button(prepared ? (error ? tFallback(t, 'common.retry', 'Retry') : tFallback(t, 'projects.convertToSection', 'Convert to section…')) : tFallback(t, 'common.next', 'Next'),
                        () => { if (prepared) void save(); else confirm(); }, busy || (!prepared && (!preview?.ok || !name.trim())))}
                </View>
            </View>
        </View>
    </Modal>;
}
