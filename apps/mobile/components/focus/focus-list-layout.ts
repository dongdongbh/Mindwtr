export const FOCUS_ESTIMATED_LIST_HEADER_HEIGHT = 64;
export const FOCUS_ESTIMATED_SECTION_HEADER_HEIGHT = 46;
export const FOCUS_ESTIMATED_GROUP_HEADER_HEIGHT = 48;
export const FOCUS_ESTIMATED_TASK_HEIGHT = 94;
export const FOCUS_ESTIMATED_PROJECT_HEIGHT = 88;

export const FOCUS_LIST_HEADER_LAYOUT_KEY = 'focus-list-header';


const FOCUS_LAYOUT_REVISION_SEPARATOR = '@layout:';

const focusLayoutKeyIdentity = (key: string): string => key.split(FOCUS_LAYOUT_REVISION_SEPARATOR)[0];

type FocusLayoutRevision = string | number | null | undefined;

export type FocusLayoutListItem =
  | { type: 'task'; task: { id: string; rev?: FocusLayoutRevision; updatedAt?: string | null } }
  | { type: 'project'; project: { id: string; rev?: FocusLayoutRevision; updatedAt?: string | null } }
  | { type: 'groupHeader'; id: string; count: number };

export type FocusLayoutSection = {
  type: string;
  totalCount: number;
  expanded: boolean;
  data: readonly FocusLayoutListItem[];
};

export type FocusListLayoutFrame = { length: number; offset: number };

export function focusSectionHeaderLayoutKey(
  section: Pick<FocusLayoutSection, 'type' | 'totalCount' | 'expanded'>,
  isFirstVisible: boolean,
): string {
  const variant = [
    isFirstVisible ? 'first' : 'rest',
    section.expanded ? 'expanded' : 'collapsed',
    section.totalCount,
  ].join(':');
  return `section-header:${section.type}${FOCUS_LAYOUT_REVISION_SEPARATOR}${variant}`;
}

export function focusItemLayoutKey(sectionType: string, item: FocusLayoutListItem): string {
  if (item.type === 'task') {
    return `${sectionType}:task:${item.task.id}${FOCUS_LAYOUT_REVISION_SEPARATOR}${item.task.rev ?? item.task.updatedAt ?? ''}`;
  }
  if (item.type === 'project') {
    return `${sectionType}:project:${item.project.id}${FOCUS_LAYOUT_REVISION_SEPARATOR}${item.project.rev ?? item.project.updatedAt ?? ''}`;
  }
  return `${sectionType}:group:${item.id}${FOCUS_LAYOUT_REVISION_SEPARATOR}${item.count}`;
}

function estimateFocusItemHeight(item: FocusLayoutListItem): number {
  if (item.type === 'task') return FOCUS_ESTIMATED_TASK_HEIGHT;
  if (item.type === 'project') return FOCUS_ESTIMATED_PROJECT_HEIGHT;
  return FOCUS_ESTIMATED_GROUP_HEADER_HEIGHT;
}

type BuildFocusListLayoutFramesOptions = {
  measuredHeights: Readonly<Record<string, number>>;
  firstVisibleSectionType: string | null;
};


export function buildFocusListLayoutFrames(
  sections: readonly FocusLayoutSection[],
  { measuredHeights, firstVisibleSectionType }: BuildFocusListLayoutFramesOptions,
): FocusListLayoutFrame[] {
  let offset = measuredHeights[FOCUS_LIST_HEADER_LAYOUT_KEY] ?? FOCUS_ESTIMATED_LIST_HEADER_HEIGHT;
  const frames: FocusListLayoutFrame[] = [];
  const push = (length: number) => {
    frames.push({ length, offset });
    offset += length;
  };
  for (const section of sections) {
    if (section.totalCount === 0) {

      push(0);
    } else {
      const headerKey = focusSectionHeaderLayoutKey(section, section.type === firstVisibleSectionType);
      push(measuredHeights[headerKey] ?? FOCUS_ESTIMATED_SECTION_HEADER_HEIGHT);
    }
    for (const item of section.data) {
      push(measuredHeights[focusItemLayoutKey(section.type, item)] ?? estimateFocusItemHeight(item));
    }
    push(0);
  }
  return frames;
}

export function collectFocusListLayoutKeys(
  sections: readonly FocusLayoutSection[],
  firstVisibleSectionType: string | null,
): Set<string> {
  const keys = new Set<string>([FOCUS_LIST_HEADER_LAYOUT_KEY]);
  for (const section of sections) {
    keys.add(focusSectionHeaderLayoutKey(section, section.type === firstVisibleSectionType));
    for (const item of section.data) {
      keys.add(focusItemLayoutKey(section.type, item));
    }
  }
  return keys;
}


export function reconcileFocusListMeasuredHeights(
  sections: readonly FocusLayoutSection[],
  firstVisibleSectionType: string | null,
  measuredHeights: Readonly<Record<string, number>>,
): { heights: Record<string, number>; changed: boolean } {
  const activeKeys = collectFocusListLayoutKeys(sections, firstVisibleSectionType);
  const activeKeyByIdentity = new Map<string, string>();
  activeKeys.forEach((key) => {
    activeKeyByIdentity.set(focusLayoutKeyIdentity(key), key);
  });
  const heights: Record<string, number> = {};
  let changed = false;
  for (const [key, height] of Object.entries(measuredHeights)) {
    if (activeKeys.has(key)) {
      heights[key] = height;
      continue;
    }
    changed = true;
    const successor = activeKeyByIdentity.get(focusLayoutKeyIdentity(key));
    if (
      successor !== undefined
      && heights[successor] === undefined
      && measuredHeights[successor] === undefined
    ) {
      heights[successor] = height;
    }
  }
  return { heights, changed };
}
