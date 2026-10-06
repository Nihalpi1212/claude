import React, { useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Tap, Txt, haptic } from '@/components/ui';
import { Header } from '@/components/Header';
import { useT } from '@/i18n';
import { useTheme } from '@/theme';

export default function Help() {
  const t = useTheme();
  const { t: tr } = useT();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<number | null>(0);
  const faqs = [[tr('faq1q'), tr('faq1a')], [tr('faq2q'), tr('faq2a')], [tr('faq3q'), tr('faq3a')], [tr('faq4q'), tr('faq4a')]];
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header title={tr('helpCenter')} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <Txt variant="subhead" color="secondary">{tr('helpBody')}</Txt>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Button style={{ flex: 1 }} small title={tr('contactSupport')} icon="logo-whatsapp" onPress={() => Linking.openURL('https://wa.me/97444001234')} />
          <Button style={{ flex: 1 }} small variant="secondary" title="4400 1234" icon="call" onPress={() => Linking.openURL('tel:+97444001234')} />
        </View>
        {faqs.map(([q, a], i) => (
          <Animated.View key={q} entering={FadeInDown.delay(i * 50).springify().damping(18)} layout={LinearTransition.springify()}>
            <Card onPress={() => { haptic.select(); setOpen(open === i ? null : i); }} style={{ padding: 16, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Txt variant="callout" style={{ flex: 1, fontWeight: '700' }}>{q}</Txt>
                <Ionicons name={open === i ? 'chevron-up' : 'chevron-down'} size={18} color={t.textTertiary} />
              </View>
              {open === i ? <Txt variant="subhead" color="secondary">{a}</Txt> : null}
            </Card>
          </Animated.View>
        ))}
      </ScrollView>
    </View>
  );
}
