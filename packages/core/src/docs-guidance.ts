
type DocsLocale = 'en' | 'de' | 'es' | 'fr' | 'zh-Hans' | 'zh-Hant';

export type DocsSection =
    | 'sync-encryption'
    | 'basic-workflow'
    | 'desktop-inbox'
    | 'desktop-focus'
    | 'desktop-scheduling'
    | 'desktop-details'
    | 'mobile-inbox'
    | 'mobile-focus'
    | 'mobile-scheduling'
    | 'mobile-details';


const SECTION_ANCHORS: Record<DocsSection, Record<DocsLocale, string>> = {
    'sync-encryption': {
        en: 'sync-encryption', de: 'sync-verschlusselung', es: 'cifrado-de-la-sincronizacion',
        fr: 'chiffrement-de-la-synchronisation', 'zh-Hans': '同步加密', 'zh-Hant': '同步加密',
    },
    'basic-workflow': {
        en: 'the-basic-workflow', de: 'der-grundlegende-arbeitsablauf', es: 'flujo-de-trabajo-basico',
        fr: 'flux-de-base', 'zh-Hans': '基本工作流程', 'zh-Hant': '基本工作流程',
    },
    'desktop-inbox': {
        en: '📥-inbox', de: '📥-eingang', es: '📥-bandeja-de-entrada',
        fr: '📥-boite-de-reception', 'zh-Hans': '📥-收件箱', 'zh-Hant': '📥-收集箱',
    },
    'desktop-focus': {
        en: '🎯-focus', de: '🎯-fokus', es: '🎯-foco',
        fr: '🎯-focus', 'zh-Hans': '🎯-专注', 'zh-Hant': '🎯-專注',
    },
    'desktop-scheduling': {
        en: 'task-properties', de: 'aufgabeneigenschaften', es: 'propiedades-de-las-tareas',
        fr: 'proprietes-des-taches', 'zh-Hans': '任务属性', 'zh-Hant': '任務屬性',
    },
    'desktop-details': {
        en: 'task-editor-view-edit', de: 'aufgabeneditor-ansicht-bearbeitung',
        es: 'editor-de-tareas-ver-y-editar', fr: 'editeur-de-tache-affichage-et-modification',
        'zh-Hans': '任务编辑器-查看-编辑', 'zh-Hant': '任務編輯器-檢視-編輯',
    },
    'mobile-inbox': {
        en: 'processing-inbox', de: 'eingang-verarbeiten', es: 'procesar-la-bandeja-de-entrada',
        fr: 'traiter-la-boite-de-reception', 'zh-Hans': '处理收集箱', 'zh-Hant': '處理收集箱',
    },
    'mobile-focus': {
        en: 'focus', de: 'fokus', es: 'foco', fr: 'focus', 'zh-Hans': '专注', 'zh-Hant': '專注',
    },
    'mobile-scheduling': {
        en: 'scheduling-tasks', de: 'aufgaben-planen', es: 'programar-tareas',
        fr: 'planifier-des-taches', 'zh-Hans': '安排任务', 'zh-Hant': '排程任務',
    },
    'mobile-details': {
        en: 'task-editor-task-view', de: 'aufgabeneditor-aufgabe-ansicht',
        es: 'editor-de-tareas-tarea-y-vista', fr: 'editeur-de-tache-tache-et-vue',
        'zh-Hans': '任务编辑器-任务-查看', 'zh-Hant': '任務編輯器-任務-檢視',
    },
};

export function getDocsLocale(language: string | undefined): DocsLocale {
    if (language === 'zh') return 'zh-Hans';
    if (language === 'de' || language === 'es' || language === 'fr'
        || language === 'zh-Hans' || language === 'zh-Hant') return language;
    return 'en';
}


export function getDocsGuideUrl(path: string, language?: string, section?: DocsSection): string {
    const locale = getDocsLocale(language);
    const localePath = locale === 'en' ? '' : `${locale}/`;
    const fragment = section ? `#${encodeURIComponent(SECTION_ANCHORS[section][locale])}` : '';
    return `https://docs.mindwtr.app/${localePath}${path}${fragment}`;
}
