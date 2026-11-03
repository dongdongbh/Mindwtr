


export const LOCATION_CONTEXTS = [
    '@home',
    '@work',
    '@errands',
    '@agendas',
    '@computer',
    '@phone',
    '@anywhere',
] as const;


export const ENERGY_CONTEXTS = [
    '#focused',
    '#lowenergy',
    '#creative',
    '#routine',
] as const;


export const PRESET_CONTEXTS = [
    ...LOCATION_CONTEXTS,
    ...ENERGY_CONTEXTS,
] as const;


export type LocationContext = typeof LOCATION_CONTEXTS[number];
export type EnergyContext = typeof ENERGY_CONTEXTS[number];
export type PresetContext = typeof PRESET_CONTEXTS[number];


export const PRESET_TAGS = [
    '#creative',
    '#focused',
    '#lowenergy',
    '#routine',
] as const;

export type PresetTag = typeof PRESET_TAGS[number];
