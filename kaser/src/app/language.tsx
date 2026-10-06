import React from 'react';
import { Alert, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Card, Row, Txt } from '@/components/ui';
import { Header } from '@/components/Header';
import { useT, type Lang } from '@/i18n';
import { useStore } from '@/store';
import { useTheme } from '@/theme';

export default function Language() {
  const t = useTheme();
  const { t: tr, lang } = useT();
  const setLang = useStore((s) => s.setLang);
  const pick = (l: Lang) => {
    if (l === lang) return router.back();
    Alert.alert(tr('language'), tr('languageRestart'), [
      { text: tr('cancel'), style: 'cancel' },
      { text: tr('done'), onPress: () => { router.back(); setTimeout(() => setLang(l), 250); } },
    ]);
  };
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header close noTop title={tr('language')} />
      <View style={{ padding: 20 }}>
        <Card>
          {(['en', 'ar'] as const).map((l, i) => (
            <Row key={l} icon="language" title={l === 'en' ? 'English' : 'العربية'} onPress={() => pick(l)} last={i === 1} right={lang === l ? <Ionicons name="checkmark-circle" size={24} color={t.primary} /> : <View style={{ width: 24 }} />} />
          ))}
        </Card>
      </View>
    </View>
  );
}
