declare module 'expo-audio' {
  export const RecordingPresets: {
    HIGH_QUALITY: unknown;
  };

  export type AudioMode = {
    allowsRecording?: boolean;
    playsInSilentMode?: boolean;
    interruptionMode?: string;
    interruptionModeAndroid?: string;
  };

  export type RecordingPermissionResponse = {
    granted: boolean;
  };

  export interface AudioRecorder {
    uri?: string | null;
    prepareToRecordAsync(): Promise<void>;
    record(): void;
    stop(): Promise<void>;
  }

  export interface AudioSource {
    uri: string;
  }

  export interface AudioPlayer {
    play(): Promise<void> | void;
    pause(): Promise<void> | void;
    replace(source: AudioSource | null): void;
    seekTo(positionSeconds: number): Promise<void> | void;
  }

  export type AudioPlayerStatus = {
    isLoaded: boolean;
    playing: boolean;
    duration: number;
    currentTime: number;
    didJustFinish: boolean;
  };

  export function requestRecordingPermissionsAsync(): Promise<RecordingPermissionResponse>;
  export function setAudioModeAsync(mode: AudioMode): Promise<void>;
  export function useAudioRecorder(preset?: unknown): AudioRecorder;
  export function useAudioPlayer(
    source: AudioSource | null,
    options?: { updateInterval?: number }
  ): AudioPlayer;
  export function useAudioPlayerStatus(player: AudioPlayer): AudioPlayerStatus;
}

declare module 'expo-auth-session' {
  export enum ResponseType {
    Code = 'code',
  }

  export type DiscoveryDocument = {
    authorizationEndpoint: string;
    tokenEndpoint: string;
  };

  export type PromptResult = {
    type: string;
    params?: Record<string, string>;
  };

  export type ExchangeTokenResult = {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };

  export class AuthRequest {
    codeVerifier?: string;

    constructor(config: {
      clientId: string;
      redirectUri: string;
      responseType: ResponseType;
      usePKCE?: boolean;
      scopes?: string[];
      extraParams?: Record<string, string>;
    });

    promptAsync(discovery: DiscoveryDocument): Promise<PromptResult>;
  }

  export function makeRedirectUri(options?: {
    scheme?: string;
    path?: string;
    native?: string;
  }): string;

  export function exchangeCodeAsync(
    config: {
      clientId: string;
      code: string;
      redirectUri: string;
      extraParams?: Record<string, string>;
    },
    discovery: DiscoveryDocument
  ): Promise<ExchangeTokenResult>;
}

declare module 'expo-calendar' {
  export type PermissionStatus = 'undetermined' | 'granted' | 'denied';

  export interface Calendar {
    id: string;
    title?: string;
    name?: string;
    color?: string;
  }

  export interface Event {
    id?: string;
    calendarId?: string;
    startDate: string | Date;
    endDate?: string | Date;
    allDay?: boolean;
    title?: string;
    notes?: string;
    location?: string;
  }

  export const EntityTypes: {
    EVENT: string;
  };

  export function getCalendarPermissionsAsync(): Promise<{ status: PermissionStatus }>;
  export function requestCalendarPermissionsAsync(): Promise<{ status: PermissionStatus }>;
  export function getCalendarsAsync(entityType: string): Promise<Calendar[]>;
  export function getEventsAsync(calendarIds: string[], startDate: Date, endDate: Date): Promise<Event[]>;
}

declare module 'expo-network' {
  export interface NetworkState {
    isConnected?: boolean | null;
    isInternetReachable?: boolean | null;
    isAirplaneModeEnabled?: boolean | null;
  }

  export function getNetworkStateAsync(): Promise<NetworkState>;
  export function addNetworkStateListener(
    listener: (state: NetworkState) => void
  ): { remove?: () => void };
}

declare module 'react-native-fs' {
  export function writeFile(path: string, contents: string, encoding?: string): Promise<void>;
  export function appendFile(path: string, contents: string, encoding?: string): Promise<void>;
  export function readFile(path: string, encoding?: string): Promise<string>;
  export function exists(path: string): Promise<boolean>;
  export function unlink(path: string): Promise<void>;

  declare const ReactNativeFS: {
    writeFile: typeof writeFile;
    appendFile: typeof appendFile;
    readFile: typeof readFile;
    exists: typeof exists;
    unlink: typeof unlink;
  };

  export default ReactNativeFS;
}
