import type { calendarSubscriptionSettingSource, planCalendarSubscriptionSetting } from './calendar-subscription-settings-witness';
import type { planCalendarSubscriptionAdd } from './native-host-contract-calendar-subscription-add';

/** Subscription helpers register after loading; the store must not import modules that import it. */
export const calendarSubscriptionModules: {
    setting?: { source: typeof calendarSubscriptionSettingSource; plan: typeof planCalendarSubscriptionSetting };
    add?: typeof planCalendarSubscriptionAdd;
} = {};
