import { connect, evidenced, tab } from './device.mjs';
import { resolve } from 'node:path';

const [serial] = process.argv.slice(2);
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
const { en } = await import(resolve(import.meta.dirname, '../../../packages/core/src/i18n/locales/en.ts'));
const device = connect({ serial, pkg: PKG, uiFile: '/data/local/tmp/mindwtr-native-dev-ui.xml' });

try {
    if (!device.sh(`pm list packages ${PKG}`).split('\n').some((line) => line.trim() === `package:${PKG}`)) {
        console.log(`${PKG} is not installed`);
    } else {
        await device.stopApp();
        if (!device.front().includes(`${device.home}/`)) device.sh('input keyevent KEYCODE_HOME');
        await device.waitFor('the launcher in front', () => device.front().includes(`${device.home}/`), 10_000);
        device.launch(`${PKG}/${PKG}.MainActivity`);
        await device.waitFor('the tabs past the welcome sheet', (nodes) => Boolean(tab(nodes, en['tab.menu'])), 90_000);
        await device.stopApp();
        device.sh('input keyevent KEYCODE_HOME');
        console.log(`${PKG} is past onboarding`);
    }
} catch (error) {
    evidenced(error);
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
}
