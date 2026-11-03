import { ValidationError } from './errors.js';

export type FlagValue = string | boolean;
export type FlagMap = Record<string, FlagValue>;
export type FlagEnv = Record<string, string | undefined>;

export const parseArgs = (argv: string[]): FlagMap => {
  const flags: FlagMap = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const keyValue = arg.slice(2);
    const equalsIndex = keyValue.indexOf('=');
    if (equalsIndex > 0) {
      const key = keyValue.slice(0, equalsIndex);
      const value = keyValue.slice(equalsIndex + 1);
      if (key) {
        flags[key] = value;
      }
      continue;
    }
    const key = keyValue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
};


export const parseBooleanFlag = (value: FlagValue | undefined, flagName: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  throw new ValidationError(
    `Invalid value for --${flagName}: "${value}" (expected one of: true/false, 1/0, yes/no, on/off)`
  );
};

export const readFlagValue = (flags: FlagMap, ...names: string[]): FlagValue | undefined => {
  for (const name of names) {
    if (flags[name] !== undefined) return flags[name];
  }
  return undefined;
};

export const readStringFlag = (flags: FlagMap, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};
