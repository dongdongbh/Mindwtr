// Build picker previews from the real native layouts so typography, spacing,
// and capture controls stay aligned. Only the sample content is synthetic.
const bindSample = (xml, labels, visible = []) => xml
  .replace(/<\?xml[^>]*\?>\s*/, '')
  .replace(/<[A-Za-z][^>]*>/g, (tag) => {
    const id = tag.match(/android:id="@\+id\/([^"]+)"/)?.[1];
    if (id && Object.hasOwn(labels, id)) {
      tag = tag.replace(/\sandroid:text="[^"]*"/, '');
      tag = tag.replace(/\s*\/?>$/, (end) => ` android:text="${labels[id]}"${end}`);
    }
    if (visible.includes(id)) tag = tag.replace('android:visibility="gone"', 'android:visibility="visible"');
    if (id === 'mindwtr_widget_empty') tag = tag.replace(/\s*\/?>$/, (end) => ` android:visibility="gone"${end}`);
    return tag;
  });

const buildWidgetPreviewXml = (kind, readLayout) => {
  const compact = kind.kind === 'Compact';
  const labels = {
    mindwtr_widget_title: kind.kind === 'QuickCapture' ? 'Quick capture' : compact ? 'Today\'s Focus' : 'Monday, Sep 7',
    mindwtr_widget_subtitle: 'Inbox: 3',
    mindwtr_widget_capture_label: compact ? 'Quick capture' : '+',
  };
  let xml = bindSample(readLayout(kind.layout), labels);
  if (kind.kind !== 'QuickCapture') {
    const titles = ['Plan the week', 'Pick up groceries'];
    const rows = titles.map((title, index) => bindSample(
      readLayout(compact ? 'mindwtr_compact_widget_item' : 'mindwtr_widget_item'),
      {
        mindwtr_widget_item_title: compact ? `• ${title}` : title,
        mindwtr_widget_item_context: index === 0 ? 'Work' : 'Personal',
        mindwtr_widget_item_due: index === 0 ? 'Today' : '',
      },
      compact ? [] : ['mindwtr_widget_item_context_row'],
    // Rows are flattened into one preview layout, unlike runtime ListView
    // children. Namespace definitions and references to keep IDs unique.
    ).replace(/@(\+?)id\/([A-Za-z0-9_]+)/g, `@$1id/$2_preview_${index}`));
    if (!compact) rows.unshift(bindSample(readLayout('mindwtr_widget_section'), { mindwtr_widget_section_title: 'Today\'s Focus' }));
    xml = xml.replace(/<ListView\b([^>]*?)\/>/, (_, attributes) => {
      const supported = attributes.replace(/\sandroid:(?:divider|dividerHeight|scrollbars)="[^"]*"/g, '');
      return `<LinearLayout${supported} android:orientation="vertical">${rows.join('\n')}</LinearLayout>`;
    });
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n${xml}`;
};

module.exports = { buildWidgetPreviewXml };
