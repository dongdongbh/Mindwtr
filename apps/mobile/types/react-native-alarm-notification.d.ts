declare module 'react-native-alarm-notification' {
  export type AlarmDetails = Record<string, unknown>;

  const ReactNativeAlarmNotification: {
    parseDate: (date: Date) => string;
    scheduleAlarm: (details: AlarmDetails) => Promise<{ id?: number | string }>;
    sendNotification?: (details: AlarmDetails) => void;
    deleteAlarm: (id: number) => void;
    deleteRepeatingAlarm: (id: number) => void;
    stopAlarmSound: () => void;
    removeFiredNotification: (id: number) => void;
    removeAllFiredNotifications: () => void;
    getScheduledAlarms: () => Promise<Array<Record<string, unknown>>>;
    requestPermissions?: (permissions: { alert: boolean; badge: boolean; sound: boolean }) => Promise<unknown>;
    checkPermissions?: (callback: (permissions: unknown) => void) => void;
  };

  export default ReactNativeAlarmNotification;
}
