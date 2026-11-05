import type { M3ColorRoles } from './m3-color';

export type M3ElevationLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface ElevationStyle {
  backgroundColor?: string;
  shadowColor?: string;
  shadowOffset?: { width: number; height: number };
  shadowOpacity?: number;
  shadowRadius?: number;
  elevation?: number;
}

const SURFACE_BY_LEVEL = (roles: M3ColorRoles): Record<M3ElevationLevel, string> => ({
  0: roles.surface,
  1: roles.surfaceContainerLow,
  2: roles.surfaceContainer,
  3: roles.surfaceContainerHigh,
  4: roles.surfaceContainerHighest,
  5: roles.surfaceContainerHighest,
});


const SHADOW_BY_LEVEL: Record<M3ElevationLevel, { dp: number; opacity: number; radius: number; height: number }> = {
  0: { dp: 0, opacity: 0, radius: 0, height: 0 },
  1: { dp: 1, opacity: 0.10, radius: 1.5, height: 1 },
  2: { dp: 3, opacity: 0.12, radius: 3, height: 2 },
  3: { dp: 6, opacity: 0.14, radius: 5, height: 3 },
  4: { dp: 8, opacity: 0.16, radius: 7, height: 4 },
  5: { dp: 12, opacity: 0.18, radius: 10, height: 6 },
};

export function buildElevationStyle(
  level: M3ElevationLevel,
  opts: { isMaterial: boolean; roles: M3ColorRoles | null },
): ElevationStyle {
  if (!opts.isMaterial || !opts.roles) return {};
  const surface = SURFACE_BY_LEVEL(opts.roles)[level];
  const s = SHADOW_BY_LEVEL[level];
  if (level === 0) return { backgroundColor: surface, elevation: 0 };
  return {
    backgroundColor: surface,
    shadowColor: opts.roles.shadow,
    shadowOffset: { width: 0, height: s.height },
    shadowOpacity: s.opacity,
    shadowRadius: s.radius,
    elevation: s.dp,
  };
}
