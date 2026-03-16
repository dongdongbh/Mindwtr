import { requireNativeModule } from 'expo-modules-core';

// The native module must be loaded with requireNativeModule (not NativeModulesProxy)
// so that EventEmitter can attach to it in Expo SDK 54+.
export default requireNativeModule('CloudKitSync');
