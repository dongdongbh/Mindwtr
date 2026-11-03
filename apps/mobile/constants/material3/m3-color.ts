export interface M3ColorRoles {
  primary: string; onPrimary: string; primaryContainer: string; onPrimaryContainer: string;
  secondary: string; onSecondary: string; secondaryContainer: string; onSecondaryContainer: string;
  tertiary: string; onTertiary: string; tertiaryContainer: string; onTertiaryContainer: string;
  error: string; onError: string; errorContainer: string; onErrorContainer: string;
  background: string; onBackground: string;
  surface: string; onSurface: string; surfaceVariant: string; onSurfaceVariant: string;
  surfaceContainerLowest: string; surfaceContainerLow: string; surfaceContainer: string;
  surfaceContainerHigh: string; surfaceContainerHighest: string;
  outline: string; outlineVariant: string;
  inverseSurface: string; inverseOnSurface: string; inversePrimary: string;
  surfaceTint: string; scrim: string; shadow: string;

  success: string; onSuccess: string; warning: string; onWarning: string;

  text: string; secondaryText: string;
}

export const M3Colors: { light: M3ColorRoles; dark: M3ColorRoles } = {
  light: {
    primary: '#1B6EF3', onPrimary: '#FFFFFF', primaryContainer: '#D7E2FF', onPrimaryContainer: '#001B3E',
    secondary: '#565E71', onSecondary: '#FFFFFF', secondaryContainer: '#DAE2F9', onSecondaryContainer: '#131C2B',
    tertiary: '#705574', onTertiary: '#FFFFFF', tertiaryContainer: '#FAD8FD', onTertiaryContainer: '#28132E',
    error: '#BA1A1A', onError: '#FFFFFF', errorContainer: '#FFDAD6', onErrorContainer: '#410002',
    background: '#F9FAFF', onBackground: '#1A1C1E',
    surface: '#F9FAFF', onSurface: '#1A1C1E', surfaceVariant: '#DFE3EB', onSurfaceVariant: '#43474F',
    surfaceContainerLowest: '#FFFFFF', surfaceContainerLow: '#F3F4FA', surfaceContainer: '#EEF1F7',
    surfaceContainerHigh: '#E5E9F0', surfaceContainerHighest: '#DFE3EA',
    outline: '#73777F', outlineVariant: '#C3C6CF',
    inverseSurface: '#2F3033', inverseOnSurface: '#F1F0F4', inversePrimary: '#AAC7FF',
    surfaceTint: '#1B6EF3', scrim: '#000000', shadow: '#000000',
    success: '#0F7B3D', onSuccess: '#FFFFFF', warning: '#8C5A00', onWarning: '#FFFFFF',
    text: '#1A1C1E', secondaryText: '#43474F',
  },
  dark: {
    primary: '#AAC7FF', onPrimary: '#003063', primaryContainer: '#00458B', onPrimaryContainer: '#D7E2FF',
    secondary: '#BEC6DC', onSecondary: '#283041', secondaryContainer: '#3E4759', onSecondaryContainer: '#DAE2F9',
    tertiary: '#DDBCE0', onTertiary: '#3F2844', tertiaryContainer: '#573E5C', onTertiaryContainer: '#FAD8FD',
    error: '#FFB4AB', onError: '#690005', errorContainer: '#93000A', onErrorContainer: '#FFDAD6',
    background: '#111318', onBackground: '#E3E2E6',
    surface: '#111318', onSurface: '#E3E2E6', surfaceVariant: '#43474E', onSurfaceVariant: '#C3C6CF',
    surfaceContainerLowest: '#0C0E13', surfaceContainerLow: '#191C20', surfaceContainer: '#1B1E24',
    surfaceContainerHigh: '#22252B', surfaceContainerHighest: '#2D3037',
    outline: '#8D9199', outlineVariant: '#43474E',
    inverseSurface: '#E3E2E6', inverseOnSurface: '#2F3033', inversePrimary: '#1B6EF3',
    surfaceTint: '#AAC7FF', scrim: '#000000', shadow: '#000000',
    success: '#7CDC94', onSuccess: '#00391C', warning: '#F2C16E', onWarning: '#472A00',
    text: '#E3E2E6', secondaryText: '#C3C6CF',
  },
};
