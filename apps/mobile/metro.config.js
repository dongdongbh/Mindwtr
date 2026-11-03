const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const isFossBuild = process.env.FOSS_BUILD === '1' || process.env.FOSS_BUILD === 'true';
const projectNodeModulesRoot = path.resolve(projectRoot, 'node_modules');
const coreNodeModulesRoot = path.resolve(workspaceRoot, 'packages/core/node_modules');
const workspaceNodeModulesRoot = path.resolve(workspaceRoot, 'node_modules');
const workspaceBabelRuntimeRoot = path.resolve(workspaceRoot, 'node_modules/@babel/runtime');
const fossStoreReviewShim = path.resolve(projectRoot, 'shims/expo-store-review-foss.js');
const projectReactRoot = path.resolve(projectNodeModulesRoot, 'react');
const projectReactNativeRoot = path.resolve(projectNodeModulesRoot, 'react-native');
const zustandRoot = fs.existsSync(path.resolve(projectNodeModulesRoot, 'zustand'))
    ? path.resolve(projectNodeModulesRoot, 'zustand')
    : path.resolve(coreNodeModulesRoot, 'zustand');
const whisperRnRoot = fs.existsSync(path.resolve(projectNodeModulesRoot, 'whisper.rn'))
    ? path.resolve(projectNodeModulesRoot, 'whisper.rn')
    : path.resolve(workspaceNodeModulesRoot, 'whisper.rn');
const resolveFromProjectNodeModules = (moduleName) => {
    try {
        return require.resolve(moduleName, {
            paths: [projectNodeModulesRoot],
        });
    } catch {
        return null;
    }
};

const resolveWhisperRnPath = (relativePath) => {
    const fullPath = path.resolve(whisperRnRoot, relativePath);
    return fs.existsSync(fullPath) ? fullPath : null;
};

const config = getDefaultConfig(projectRoot);


if (process.env.CI === '1' || process.env.CI === 'true') {
    config.resolver.useWatchman = false;
}


const captureProfiling = process.env.EXPO_PUBLIC_CAPTURE_PROFILING === '1';
const startupProfiling = ['1', 'true'].includes(
    String(process.env.EXPO_PUBLIC_STARTUP_PROFILING || '').trim().toLowerCase(),
);
config.cacheVersion = `${config.cacheVersion}-mindwtr-profiling-${Number(captureProfiling)}-${Number(startupProfiling)}`;


config.serializer = {
    ...config.serializer,
    getModulesRunBeforeMainModule: () => [
        require.resolve('./shims/timers-bootstrap.js'),
        require.resolve('./shims/url-polyfill.js'),
    ],
};


const defaultWatchFolders = config.watchFolders || [];
config.watchFolders = Array.from(new Set([...defaultWatchFolders, workspaceRoot]));


config.resolver.blockList = [
    /apps\/desktop\/src-tauri\/target\/.*/,
    /apps\/mobile\/app\/.*\.(?:test|spec)\.[jt]sx?$/,
    /(^|\/)\.worktrees\/.*/,
    /\.git\/.*/,
    /node_modules\/.*\/\.git\/.*/,


    /(^|\/)coverage\/.*/,
];


config.resolver.nodeModulesPaths = [
    projectNodeModulesRoot,
    coreNodeModulesRoot,
    workspaceNodeModulesRoot,
];
config.resolver.disableHierarchicalLookup = false;


config.resolver.extraNodeModules = {
    react: projectReactRoot,
    'react-native': projectReactNativeRoot,
    zustand: zustandRoot,
    '@babel/runtime': workspaceBabelRuntimeRoot,
};


config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];


config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (isFossBuild && moduleName === 'expo-store-review') {
        return {
            filePath: fossStoreReviewShim,
            type: 'sourceFile',
        };
    }


    if (
        moduleName.startsWith('./')
        && context.originModulePath
        && context.originModulePath.includes('/@babel/runtime/helpers/')
    ) {
        const helperRelativePath = path.resolve(path.dirname(context.originModulePath), moduleName);
        if (fs.existsSync(helperRelativePath)) {
            return {
                filePath: helperRelativePath,
                type: 'sourceFile',
            };
        }
    }

    if (
        moduleName === 'whisper.rn'
        || moduleName === 'whisper.rn/index'
        || moduleName === 'whisper.rn/src/index'
    ) {
        const resolved = resolveWhisperRnPath('src/index.ts')
            || resolveWhisperRnPath('lib/commonjs/index.js');
        if (resolved) {
            return {
                filePath: resolved,
                type: 'sourceFile',
            };
        }
    }

    if (
        moduleName === 'whisper.rn/realtime-transcription'
        || moduleName === 'whisper.rn/realtime-transcription/index'
        || moduleName === 'whisper.rn/realtime-transcription/index.js'
    ) {
        const resolved = resolveWhisperRnPath('lib/commonjs/realtime-transcription/index.js');
        if (resolved) {
            return {
                filePath: resolved,
                type: 'sourceFile',
            };
        }
    }

    if (
        moduleName === 'whisper.rn/realtime-transcription/adapters/AudioPcmStreamAdapter'
        || moduleName === 'whisper.rn/realtime-transcription/adapters/AudioPcmStreamAdapter.js'
    ) {
        const resolved = resolveWhisperRnPath('lib/commonjs/realtime-transcription/adapters/AudioPcmStreamAdapter.js');
        if (resolved) {
            return {
                filePath: resolved,
                type: 'sourceFile',
            };
        }
    }


    if (moduleName === 'react' || moduleName.startsWith('react/')) {
        try {
            const resolved = require.resolve(moduleName, {
                paths: [projectNodeModulesRoot],
            });
            return {
                filePath: resolved,
                type: 'sourceFile',
            };
        } catch {

        }
    }

    if (moduleName === 'react-native' || moduleName.startsWith('react-native/')) {
        try {
            const resolved = require.resolve(moduleName, {
                paths: [projectNodeModulesRoot],
            });
            return {
                filePath: resolved,
                type: 'sourceFile',
            };
        } catch {

        }
    }

    if (moduleName === 'zustand' || moduleName.startsWith('zustand/')) {
        try {
            const resolved = require.resolve(moduleName, {
                paths: [projectNodeModulesRoot, coreNodeModulesRoot, workspaceNodeModulesRoot],
            });
            return {
                filePath: resolved,
                type: 'sourceFile',
            };
        } catch {

        }
    }


    if (
        moduleName === 'expo'
        || moduleName.startsWith('expo/')
        || moduleName.startsWith('expo-')
        || moduleName.startsWith('@expo/')
    ) {
        const resolved = resolveFromProjectNodeModules(moduleName);
        if (resolved) {
            return {
                filePath: resolved,
                type: 'sourceFile',
            };
        }
    }


    if (
        moduleName === 'react-native-url-polyfill' ||
        moduleName === 'react-native-url-polyfill/auto' ||
        moduleName.startsWith('react-native-url-polyfill/') ||
        moduleName === 'whatwg-url-without-unicode' ||
        moduleName.startsWith('whatwg-url-without-unicode/')
    ) {
        return {
            filePath: path.resolve(projectRoot, 'shims/url-polyfill.js'),
            type: 'sourceFile',
        };
    }


    if (moduleName === '@mindwtr/core/share-card') {
        return {
            filePath: path.resolve(workspaceRoot, 'packages/core/src/share-card.ts'),
            type: 'sourceFile',
        };
    }


    if (moduleName === '@mindwtr/core' || moduleName.startsWith('@mindwtr/core/')) {
        const corePath = path.resolve(workspaceRoot, 'packages/core/src/index.ts');
        return {
            filePath: corePath,
            type: 'sourceFile',
        };
    }


    if (moduleName === '@babel/runtime' || moduleName.startsWith('@babel/runtime/')) {
        const helperPath = path.resolve(workspaceRoot, 'node_modules', `${moduleName}.js`);
        if (moduleName !== '@babel/runtime' && fs.existsSync(helperPath)) {
            return {
                filePath: helperPath,
                type: 'sourceFile',
            };
        }
        try {
            const resolved = require.resolve(moduleName, {
                paths: [workspaceRoot, projectRoot],
            });
            return {
                filePath: resolved,
                type: 'sourceFile',
            };
        } catch {

        }
    }

    return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
