const fs = require('fs');
const path = require('path');

const newVersion = process.argv[2];
if (!newVersion) {
    console.error('Usage: node update-versions.js <version>');
    process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error('Error: App/package version must be a stable x.y.z version. For RC releases, pass the RC tag to scripts/bump-version.sh so it can derive the stable base version.');
    process.exit(1);
}

const jsonFiles = [
    'package.json',
    'apps/desktop/package.json',
    'apps/mobile/package.json',
    'apps/cloud/package.json',
    'packages/core/package.json',
    'apps/mobile/app.json',
    'apps/desktop/src-tauri/tauri.conf.json'
];

const cargoTomlFiles = [
    'apps/desktop/src-tauri/Cargo.toml'
];

const cargoLockFiles = [
    'apps/desktop/src-tauri/Cargo.lock'
];

console.log(`Updating versions to ${newVersion}...\n`);

jsonFiles.forEach(file => {
    const filePath = path.resolve(__dirname, '..', file);
    if (fs.existsSync(filePath)) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const json = JSON.parse(content);

            let updated = false;


            if (json.version) {
                console.log(`Updating ${file} version from ${json.version} to ${newVersion}`);
                json.version = newVersion;
                updated = true;
            }


            if (Array.isArray(json.packages)) {
                json.packages.forEach((pkg, index) => {
                    if (pkg && pkg.version) {
                        const label = pkg.identifier || pkg.name || `package ${index + 1}`;
                        console.log(`Updating ${file} ${label} version from ${pkg.version} to ${newVersion}`);
                        pkg.version = newVersion;
                        updated = true;
                    }
                });
            }


            if (json.expo && json.expo.version) {
                console.log(`Updating ${file} (expo) version from ${json.expo.version} to ${newVersion}`);
                json.expo.version = newVersion;
                updated = true;
            }

            if (updated) {
                fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
            } else {
                console.warn(`Warning: No version field found in ${file}`);
            }
        } catch (e) {
            console.error(`Error processing ${file}: ${e.message}`);
            process.exit(1);
        }
    } else {
        console.warn(`Warning: File not found: ${file}`);
    }
});

cargoTomlFiles.forEach(file => {
    const filePath = path.resolve(__dirname, '..', file);
    if (!fs.existsSync(filePath)) {
        console.warn(`Warning: File not found: ${file}`);
        return;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const updated = content.replace(
            /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m,
            (_, prefix, currentVersion, suffix) => {
                console.log(`Updating ${file} version from ${currentVersion} to ${newVersion}`);
                return `${prefix}${newVersion}${suffix}`;
            }
        );

        if (updated === content) {
            console.warn(`Warning: No package version field found in ${file}`);
            return;
        }

        fs.writeFileSync(filePath, updated);
    } catch (e) {
        console.error(`Error processing ${file}: ${e.message}`);
        process.exit(1);
    }
});

cargoLockFiles.forEach(file => {
    const filePath = path.resolve(__dirname, '..', file);
    if (!fs.existsSync(filePath)) {
        console.warn(`Warning: File not found: ${file}`);
        return;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const updated = content.replace(
            /(\[\[package\]\]\nname = "mindwtr"\nversion = ")([^"]+)(")/,
            (_, prefix, currentVersion, suffix) => {
                console.log(`Updating ${file} root package version from ${currentVersion} to ${newVersion}`);
                return `${prefix}${newVersion}${suffix}`;
            }
        );

        if (updated === content) {
            console.warn(`Warning: No root package version entry found in ${file}`);
            return;
        }

        fs.writeFileSync(filePath, updated);
    } catch (e) {
        console.error(`Error processing ${file}: ${e.message}`);
        process.exit(1);
    }
});

console.log('\nRunning bun install to update lockfile...');
try {
    require('child_process').execSync('bun install', { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
} catch (e) {
    console.error(`Error running bun install: ${e.message}`);
    process.exit(1);
}

console.log('\nVersion update complete.');
