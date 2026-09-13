// Launcher copy is resolved by Android before the app/payload is available.
// Keep locale coverage aligned with packages/core/src/i18n/locales.
const compactWidgetLocales = {
  en: ['Compact', 'A simple focus list with quick capture'],
  ar: ['مختصر', 'قائمة تركيز بسيطة مع إضافة سريعة'],
  cs: ['Kompaktní', 'Jednoduchý seznam zaměření s rychlým přidáním'],
  de: ['Kompakt', 'Eine einfache Fokusliste mit Schnellerfassung'],
  es: ['Compacto', 'Una lista de enfoque sencilla con captura rápida'],
  fa: ['فشرده', 'فهرست تمرکز ساده با ثبت سریع'],
  fr: ['Compact', 'Une liste de tâches prioritaires avec saisie rapide'],
  hi: ['संक्षिप्त', 'त्वरित कैप्चर के साथ एक सरल फ़ोकस सूची'],
  hu: ['Kompakt', 'Egyszerű fókuszlista gyors rögzítéssel'],
  it: ['Compatto', 'Un semplice elenco di attività in evidenza con acquisizione rapida'],
  ja: ['コンパクト', 'クイックキャプチャ付きのシンプルなフォーカスリスト'],
  ko: ['간결', '빠른 추가가 있는 간단한 집중 목록'],
  nl: ['Compact', 'Een eenvoudige focuslijst met snelle invoer'],
  pl: ['Kompaktowy', 'Prosta lista skupienia z szybkim dodawaniem'],
  pt: ['Compacto', 'Uma lista de foco simples com captura rápida'],
  ru: ['Компактный', 'Простой список фокуса с быстрым добавлением'],
  sv: ['Kompakt', 'En enkel fokuslista med snabbregistrering'],
  tr: ['Kompakt', 'Hızlı kayıt içeren sade bir odak listesi'],
  vi: ['Thu gọn', 'Danh sách tập trung đơn giản với ghi nhanh'],
  'zh-Hans': ['简洁', '简单的专注列表，支持快速收集'],
  'zh-Hant': ['簡潔', '簡單的專注清單，支援快速收集'],
};

const compactWidgetValuesDirectory = (locale) => locale.startsWith('zh-')
  ? `values-b+${locale.replace('-', '+')}`
  : `values-${locale}`;

module.exports = { compactWidgetLocales, compactWidgetValuesDirectory };
