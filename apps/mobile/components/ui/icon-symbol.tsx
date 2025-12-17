// Fallback using simple emoji icons instead of MaterialIcons to avoid font loading issues

import { Text } from 'react-native';
import { type StyleProp, type TextStyle } from 'react-native';

type IconSymbolName = keyof typeof MAPPING;

/**
 * Add your SF Symbols to emoji mappings here.
 */
const MAPPING = {
  'house.fill': '🏠',
  'paperplane.fill': '📤',
  'chevron.left.forwardslash.chevron.right': '💻',
  'chevron.right': '›',
  'tray.fill': '📥',
  'arrow.right.circle.fill': '▶️',
  'pause.circle.fill': '⏸️',
  'folder.fill': '📁',
  'square.grid.2x2.fill': '🗂️',
  'line.3.horizontal': '☰',
  'calendar.fill': '📆',
  'calendar': '🗓️',
  'checkmark.circle.fill': '✅',
  'circle': '⚪',
  'arrow.up.circle.fill': '⬆️',
} as const;

/**
 * An icon component that uses emoji to avoid font loading issues.
 * Icon `name`s are based on SF Symbols and mapped to emoji.
 */
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
  return <Text style={[{ fontSize: size, color }, style]}>{MAPPING[name]}</Text>;
}
