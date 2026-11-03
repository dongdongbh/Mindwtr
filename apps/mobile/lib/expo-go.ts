


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


export const setExpoGoProbeForTests = (next: (() => boolean) | null): void => {
  probe = next ?? defaultIsExpoGo;
};
