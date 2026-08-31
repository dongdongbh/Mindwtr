// One home for "are we running inside the Expo Go client?" Native modules that
// Expo Go does not bundle (quick-crypto, the Android widget bridge, op-sqlite) must
// detect this before touching the module: requiring an absent TurboModule throws a
// loud Invariant Violation that LogBox red-boxes on every attempt.
const defaultIsExpoGo = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const constants = require('expo-constants') as {
      default?: { appOwnership?: string | null };
      appOwnership?: string | null;
    };
    return (constants.default ?? constants).appOwnership === 'expo';
  } catch {
    return false;
  }
};

let probe: () => boolean = defaultIsExpoGo;

export const isExpoGo = (): boolean => probe();

/** Test seam. Pass `null` to restore the real expo-constants probe. */
export const setExpoGoProbeForTests = (next: (() => boolean) | null): void => {
  probe = next ?? defaultIsExpoGo;
};
