import { requireOptionalNativeModule } from 'expo-modules-core';

export type GmailAuthorizationStatus = {
  available: boolean;
  connected: boolean;
  account: string | null;
  accountId: string | null;
};

export interface GmailAuthorizationModule {
  status(): Promise<GmailAuthorizationStatus>;
  connect(): Promise<GmailAuthorizationStatus>;
  cancel(): Promise<void>;
  disconnect(): Promise<{ revoked: boolean }>;
  get(path: string): Promise<unknown>;
}

export default requireOptionalNativeModule<GmailAuthorizationModule>('MindwtrGmailAuthorization');
