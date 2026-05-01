import React from 'react';
import { Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

export type DatePickerConfig = {
  show: boolean;
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
            mode="date"
            display="default"
            onChange={(event, date) => {
              if (event.type === 'dismissed') {
                cfg.onClose();
                return;
              }
              if (Platform.OS !== 'ios') cfg.onClose();
              if (!date) return;
              const next = new Date(date);
              next.setHours(9, 0, 0, 0);
              cfg.onSelect(next);
            }}
          />
        ) : null,
      )}
    </>
  );
}
