import { Alert } from 'react-native';
import { logError } from '../lib/app-log';


export function verifyPolyfills() {
    const errors: string[] = [];


    try {
        if (typeof URL === 'undefined') {
            errors.push('Global URL is undefined');
        } else {
            const u = new URL('https://example.com/path?foo=bar');
            if (u.protocol !== 'https:') errors.push('URL protocol parsing failed');
            if (u.pathname !== '/path') errors.push('URL pathname parsing failed');
            if (u.search !== '?foo=bar') errors.push('URL search parsing failed');
        }
    } catch (e) {
        errors.push(`URL instantiation failed: ${(e as Error).message}`);
    }


    try {
        if (typeof URLSearchParams === 'undefined') {
            errors.push('Global URLSearchParams is undefined');
        } else {
            const params = new URLSearchParams('foo=1&bar=2');
            if (params.get('foo') !== '1') errors.push('URLSearchParams.get failed');
            if (!params.has('bar')) errors.push('URLSearchParams.has failed');


            if (typeof (params as any).keys !== 'function') {
                errors.push('URLSearchParams.keys() is missing (Shim failed?)');
            } else {

                const keys = Array.from((params as any).keys());
                if (!keys.includes('foo')) errors.push('URLSearchParams iteration failed');
            }
        }
    } catch (e) {
        errors.push(`URLSearchParams check failed: ${(e as Error).message}`);
    }


    try {
        if (typeof URL.createObjectURL === 'undefined') {


        }
    } catch (e) {

    }

    if (errors.length > 0) {
        void logError(new Error('Polyfill checks failed'), {
            scope: 'polyfill',
            extra: { errors: errors.join('; ') },
        });
        Alert.alert(
            '⚠️ Critical Polyfill Failure',
            'The application environment is unstable:\n\n' + errors.join('\n') + '\n\nPlease check metro.config.js and shims.',
            [{ text: 'OK' }]
        );
    } else {

    }
}
