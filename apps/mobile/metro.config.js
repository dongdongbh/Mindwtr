const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const projectNodeModulesRoot = path.resolve(projectRoot, 'node_modules');
const coreNodeModulesRoot = path.resolve(workspaceRoot, 'packages/core/node_modules');
const workspaceNodeModulesRoot = path.resolve(workspaceRoot, 'node_modules');
const workspaceBabelRuntimeRoot = path.resolve(workspaceRoot, 'node_modules/@babel/runtime');
const projectReactRoot = path.resolve(projectNodeModulesRoot, 'react');
const projectReactNativeRoot = path.resolve(projectNodeModulesRoot, 'react-native');
const zustandRoot = fs.existsSync(path.resolve(projectNodeModulesRoot, 'zustand'))
    ? path.resolve(projectNodeModulesRoot, 'zustand')
    : path.resolve(coreNodeModulesRoot, 'zustand');
const resolveFromProjectNodeModules = (moduleName) => {
    try {
        return require.resolve(moduleName, {
            paths: [projectNodeModulesRoot],
        });
    } catch {
        return null;
    }
};

const config = getDefaultConfig(projectRoot);

// 0. CRITICAL: Load polyfill shim BEFORE any other module
config.serializer = {
    ...config.serializer,
    getModulesRunBeforeMainModule: () => [
        require.resolve('./shims/timers-bootstrap.js'),
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
    projectNodeModulesRoot,
    coreNodeModulesRoot,
    workspaceNodeModulesRoot,
];
config.resolver.disableHierarchicalLookup = false;

// 2.1 Force Metro to resolve runtime helpers from the workspace root.
config.resolver.extraNodeModules = {
    react: projectReactRoot,
    'react-native': projectReactNativeRoot,
    zustand: zustandRoot,
    '@babel/runtime': workspaceBabelRuntimeRoot,
};

// 3. Handle bun's symlink structure
config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];

// 4. Custom resolver to handle workspace packages and problematic modules
config.resolver.resolveRequest = (context, moduleName, platform) => {
    // Ensure relative Babel helper imports always resolve from the helper directory.
    // This avoids sporadic Expo Go resolution failures for helpers like arrayWithHoles.js.
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

    // Force all React imports (including subpaths) to resolve from app-local node_modules.
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
            // Fall through to Metro default resolver.
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
            // Fall through to Metro default resolver.
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
            // Fall through to Metro default resolver.
        }
    }

    // Force Expo packages to resolve from app-local node_modules.
    // In this monorepo we can have duplicate workspace copies, and Metro occasionally
    // mis-resolves package entrypoints like expo-modules-core during dev bundling.
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

    // Force Babel helpers to resolve from workspace root for stable helper resolution.
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
            // Fall through to Metro default resolver.
        }
    }

    return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
