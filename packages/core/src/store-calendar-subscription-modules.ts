import type { calendarSubscriptionSettingSource, planCalendarSubscriptionSetting } from './calendar-subscription-settings-witness';
import type { planCalendarSubscriptionAdd } from './native-host-contract-calendar-subscription-add';


export const calendarSubscriptionModules: {
    setting?: { source: typeof calendarSubscriptionSettingSource; plan: typeof planCalendarSubscriptionSetting };
    add?: typeof planCalendarSubscriptionAdd;
} = {};
