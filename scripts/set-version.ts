import fs from 'fs';
import path from 'path';

const version = process.argv[2];

if (!version) {
    console.error('Usage: bun set-version <version>');
    process.exit(1);
}


if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Error: Version must be in format x.y.z');
    process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');

const filesToUpdate = [
    { path: 'package.json', type: 'json', key: 'version' },
    { path: 'apps/desktop/package.json', type: 'json', key: 'version' },
    { path: 'apps/mobile/package.json', type: 'json', key: 'version' },
    { path: 'apps/mobile/app.json', type: 'expo-json', key: 'expo.version' },
    { path: 'apps/desktop/src-tauri/tauri.conf.json', type: 'json', key: 'version' },
    { path: 'apps/desktop/src-tauri/Cargo.toml', type: 'toml', key: 'version' },
];

filesToUpdate.forEach(file => {
    const filePath = path.join(rootDir, file.path);
    if (!fs.existsSync(filePath)) {
        console.warn(`Warning: File not found: ${file.path}`);
        return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    let newContent = content;

    if (file.type === 'json') {
        const json = JSON.parse(content);
        json[file.key] = version;
        newContent = JSON.stringify(json, null, 2) + '\n';
    } else if (file.type === 'expo-json') {
        const json = JSON.parse(content);

        const keys = file.key.split('.');
        let obj = json;
        for (let i = 0; i < keys.length - 1; i++) {
            obj = obj[keys[i]];
        }
        obj[keys[keys.length - 1]] = version;
        newContent = JSON.stringify(json, null, 2) + '\n';
    } else if (file.type === 'toml') {


        newContent = content.replace(/^version = ".*"$/m, `version = "${version}"`);
    }

    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log(`Updated ${file.path} to ${version}`);
});

console.log('Version update complete.');
