import { useThemeColors } from '@/hooks/use-theme-colors';
import { useThemeTokens } from '@/hooks/use-theme-tokens';

export interface FilledButtonColors {
  backgroundColor: string;


  textColor: string | undefined;
}


export function resolveFilledButtonColors(
  tokens: { isMaterial: boolean; roles: { primaryContainer: string; onPrimaryContainer: string } | null },
  tc: { tint: string },
): FilledButtonColors {
  if (tokens.isMaterial && tokens.roles) {
    return {
      backgroundColor: tokens.roles.primaryContainer,
      textColor: tokens.roles.onPrimaryContainer,
    };
  }
  return { backgroundColor: tc.tint, textColor: undefined };
}

export function useFilledButtonColors(): FilledButtonColors {
  const tokens = useThemeTokens();
  const tc = useThemeColors();
  return resolveFilledButtonColors(tokens, tc);
}
