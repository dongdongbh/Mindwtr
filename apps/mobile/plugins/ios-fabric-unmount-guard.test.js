import { describe, expect, it } from 'vitest';

const fs = require('fs');
const path = require('path');
const plugin = require('./ios-fabric-unmount-guard');

const { NATIVE_SOURCES_FOLDER, collectNativeSources, isCompiledSource } = plugin.__testables;

const nativeSourceDir = path.join(__dirname, '..', NATIVE_SOURCES_FOLDER);

describe('ios-fabric-unmount-guard plugin', () => {
  it('ships the Fabric unmount guard so prebuild can compile it into the app target', () => {
    expect(collectNativeSources(nativeSourceDir)).toContain('MWFabricUnmountGuard.m');
  });

  it('guards the React Native method the crash reports point at', () => {
    const source = fs.readFileSync(path.join(nativeSourceDir, 'MWFabricUnmountGuard.m'), 'utf8');

    expect(source).toContain('RCTViewComponentView');
    expect(source).toContain('unmountChildComponentView:index:');

    expect(source).toContain('removeFromSuperview');
  });

  it('compiles implementation files and only registers headers', () => {
    expect(isCompiledSource('MWFabricUnmountGuard.m')).toBe(true);
    expect(isCompiledSource('MWFabricUnmountGuard.mm')).toBe(true);
    expect(isCompiledSource('MWFabricUnmountGuard.h')).toBe(false);
  });

  it('ignores non-source files dropped in the folder', () => {
    expect(collectNativeSources(nativeSourceDir).every((name) => /\.(h|m|mm)$/.test(name))).toBe(true);
    expect(collectNativeSources(path.join(nativeSourceDir, 'does-not-exist'))).toEqual([]);
  });
});
