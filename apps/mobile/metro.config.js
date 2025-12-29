const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 0. CRITICAL: Load polyfill shim BEFORE any other module
config.serializer = {
    ...config.serializer,
    getModulesRunBeforeMainModule: () => [
        require.resolve('./shims/url-polyfill.js'),
    ],
};

// 1. Watch all files within the monorepo (preserve Expo defaults)
const defaultWatchFolders = config.watchFolders || [];
config.watchFolders = Array.from(new Set([...defaultWatchFolders, workspaceRoot]));

// 1.1 CRITICAL: Exclude build output directories that cause Metro to crash
config.resolver.blockList = [
    /apps\/desktop\/src-tauri\/target\/.*/,
    /\.git\/.*/,
    /node_modules\/.*\/\.git\/.*/,
];

// 2. Let Metro know where to resolve packages and in what order
config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, 'node_modules'),
    path.resolve(workspaceRoot, 'node_modules'),
];

// 2.1 Force Metro to resolve runtime helpers from the workspace root.
config.resolver.extraNodeModules = {
    '@babel/runtime': path.resolve(workspaceRoot, 'node_modules/@babel/runtime'),
};

// 3. Handle bun's symlink structure
config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];

// 4. Custom resolver to handle workspace packages and problematic modules
config.resolver.resolveRequest = (context, moduleName, platform) => {
    // Intercept ALL URL polyfill imports and redirect to our custom shim
    // This completely bypasses the problematic packages
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

    // Handle @mindwtr/core workspace package
    if (moduleName === '@mindwtr/core' || moduleName.startsWith('@mindwtr/core/')) {
        const corePath = path.resolve(workspaceRoot, 'packages/core/src/index.ts');
        return {
            filePath: corePath,
            type: 'sourceFile',
        };
    }

    return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
