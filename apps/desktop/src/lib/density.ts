export type DensityMode = 'comfortable' | 'compact' | 'condensed';


export function nextDensityMode(current: DensityMode | string | null | undefined): DensityMode {
    switch (current) {
        case 'comfortable':
            return 'compact';
        case 'compact':
            return 'condensed';
        case 'condensed':
            return 'comfortable';
        default:
            return 'compact';
    }
}
