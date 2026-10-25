import React from 'react';
import { Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { normalizeProcessInboxPickedDate } from '@mindwtr/core';

export type DatePickerConfig = {
  show: boolean;
  /** 'time' picks a clock time; the date picker keeps only the day. */
  mode?: 'date' | 'time';
  value: Date | null;
  onClose: () => void;
  onSelect: (date: Date) => void;
};

type Props = {
  configs: DatePickerConfig[];
};

export function InboxDatePickers({ configs }: Props) {
  return (
    <>
      {configs.map((cfg, i) =>
        cfg.show ? (
          <DateTimePicker
            key={i}
            value={cfg.value ?? new Date()}
            mode={cfg.mode ?? 'date'}
            display="default"
            onChange={(event, date) => {
              if (event.type === 'dismissed') {
                cfg.onClose();
                return;
              }
              if (Platform.OS !== 'ios') cfg.onClose();
              if (!date) return;
              cfg.onSelect(cfg.mode === 'time' ? date : normalizeProcessInboxPickedDate(date));
            }}
          />
        ) : null,
      )}
    </>
  );
}
