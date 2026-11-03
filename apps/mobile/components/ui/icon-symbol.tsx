import { Ionicons } from '@expo/vector-icons';
import type { StyleProp, TextStyle } from 'react-native';

type IconSymbolName = keyof typeof MAPPING;


const MAPPING = {
  'house.fill': 'home',
  'paperplane.fill': 'paper-plane',
  'chevron.left.forwardslash.chevron.right': 'code-slash',
  'chevron.right': 'chevron-forward',
  'tray.fill': 'file-tray',
  'arrow.right.circle.fill': 'arrow-forward-circle',
  'pause.circle.fill': 'pause-circle',
  'folder.fill': 'folder',
  'square.grid.2x2.fill': 'grid',
  'line.3.horizontal': 'menu',
  'calendar.fill': 'calendar',
  'calendar': 'calendar-outline',
  'checkmark.circle.fill': 'checkmark-circle',
  'clipboard.fill': 'clipboard',
  'circle': 'ellipse-outline',
  'arrow.up.circle.fill': 'arrow-up-circle',
  'book.closed.fill': 'book',
  'archivebox.fill': 'archive',
  'clock.arrow.circlepath': 'time',
  'trash.fill': 'trash',
  'gearshape.fill': 'settings',
  'questionmark.circle.fill': 'help-circle',
} as const;


export function IconSymbol({
  name,
  size = 24,
  color,
  style,
  weight: _weight,
}: {
  name: IconSymbolName;
  size?: number;
  color: string;
  style?: StyleProp<TextStyle>;
  weight?: string;
}) {
  return (
    <Ionicons
      name={MAPPING[name]}
      size={size}
      color={color}
      style={style}
    />
  );
}
