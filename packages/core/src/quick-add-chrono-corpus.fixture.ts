import { configureDateFormatting } from './date';
import { parseQuickAdd, parseQuickAddDateCommands } from './quick-add';

// The inputs of quick-add-chrono-corpus.test.ts and its frozen JSON, shared with the native bundle's check of the lazy chrono
// path (apps/android-native/bundle/lazy-chrono.test.ts). Run in UTC.

export const QUICK_ADD_CORPUS_NOW = new Date('2026-08-04T10:00:00Z');

const COMMON = [
    'Call mom tomorrow', 'Pay rent next friday', 'Dentist on 5 september at 3pm', 'Review report in 2 weeks',
    'Plan trip /due:10/8', 'Ship v2 /due:next monday /start:tomorrow', 'Deploy 26.06.', 'Deploy 26.06.2027',
    'python 3.12 upgrade', 'Meeting /due:2026-09-01 @work #urgent', 'Buy milk', 'Standup at 9:30',
    'Report due 3/4', 'Write /start:in 3 days', 'Trip from august 10 to august 12', 'Gift \\/due:tomorrow literal',
];
const LOCAL: Record<string, string[]> = {
    de: ['Zahnarzt anrufen nächsten Freitag', 'Bericht morgen', 'Miete zahlen am 5. September', 'Treffen /due:übermorgen', 'Termin in 3 Tagen um 15 Uhr'],
    es: ['Llamar al dentista el próximo viernes', 'Revisar informe el lunes', 'Enviar informe para el 5 de septiembre', 'Comprar leche del super mañana', 'Reunión /due:pasado mañana'],
    fr: ['Appeler le dentiste vendredi prochain', 'Revoir le rapport le lundi', 'Payer le loyer pour le 5 septembre', 'Réunion au 12 septembre', 'Acheter du pain demain'],
    it: ['Pagare affitto il 10 settembre', 'Rivedere report il prossimo lunedì', 'Riunione per domani', 'Chiamare /due:dopodomani'],
    ja: ['歯医者に電話 明日', 'レポート提出 来週の金曜日', '会議 9月5日 15時', '買い物 /due:明後日'],
    nl: ['Tandarts bellen volgende vrijdag', 'Rapport morgen', 'Huur betalen op 5 september', 'Vergadering /due:overmorgen'],
    pt: ['Pagar aluguel no dia 5 de setembro', 'Revisar relatório na próxima segunda', 'Comprar pão amanhã', 'Reunião /due:depois de amanhã'],
    ru: ['Позвонить врачу завтра', 'Отчёт в следующую пятницу', 'Оплатить аренду 5 сентября', 'Встреча /due:послезавтра'],
    sv: ['Ring tandläkaren på fredag', 'Rapport imorgon', 'Betala hyran den 5 september', 'Möte /due:i övermorgon'],
    zh: ['给牙医打电话 明天', '提交报告 下周五', '开会 9月5日 下午3点', '买东西 /due:后天'],
    'zh-Hant': ['給牙醫打電話 明天', '提交報告 下週五', '開會 9月5日 下午3點', '買東西 /due:後天'],
};
const CONFIGS: Array<{ language: string; dateFormat?: string }> = [
    { language: 'en' }, { language: 'en', dateFormat: 'dmy' }, { language: 'en', dateFormat: 'mdy' },
    ...Object.keys(LOCAL).map((language) => ({ language })), { language: 'pl' },
];

export const runQuickAddCorpus = () => CONFIGS.flatMap(({ language, dateFormat }) => {
    configureDateFormatting({ language: language as never, ...(dateFormat ? { dateFormat } : {}) });
    return [...COMMON, ...(LOCAL[language] ?? [])].map((input) => ({
        language, dateFormat: dateFormat ?? null, input,
        result: JSON.parse(JSON.stringify(parseQuickAdd(input, undefined, QUICK_ADD_CORPUS_NOW, undefined, { naturalLanguageDates: true }))),
        commands: JSON.parse(JSON.stringify(parseQuickAddDateCommands(input, QUICK_ADD_CORPUS_NOW))),
    }));
});
