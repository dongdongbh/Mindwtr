import { useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { translateText } from '@mindwtr/core';

import { useLanguage } from '@/contexts/language-context';

import { styles } from './settings.styles';

export function useSettingsLocalization() {
    const { language, t, setLanguage } = useLanguage();
    const isChineseLanguage = language === 'zh' || language === 'zh-Hant';
    const localize = useMemo(
        () => (enText: string, zhText?: string) =>
            isChineseLanguage && zhText ? zhText : translateText(enText, language),
        [isChineseLanguage, language],
    );

    return {
        isChineseLanguage,
        language,
        localize,
        setLanguage,
        t,
    };
}

export function useSettingsScrollContent(paddingBottom = 16) {
    const insets = useSafeAreaInsets();

    return useMemo(
        () => [styles.scrollContent, { paddingBottom: paddingBottom + insets.bottom }],
        [insets.bottom, paddingBottom],
    );
}
