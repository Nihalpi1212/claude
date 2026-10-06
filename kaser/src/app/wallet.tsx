import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Chip, Empty, Txt, haptic } from '@/components/ui';
import { Header } from '@/components/Header';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { dateLabel, money } from '@/lib/format';
import { brand, shadow, useTheme } from '@/theme';

export default function Wallet() {
  const t = useTheme();
  const { t: tr, lang } = useT();
  const insets = useSafeAreaInsets();
  const wallet = useStore((s) => s.wallet);
  const tx = useStore((s) => s.walletTx);
  const topUp = useStore((s) => s.topUp);
  const [amt, setAmt] = useState(100);
  const title = (k: string) => (k === 'topup' ? tr('topupTx') : k === 'cashback' ? tr('cashback') : tr('orderTx'));
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header title={tr('walletTitle')} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <Animated.View entering={FadeInDown.springify().damping(18)}>
          <LinearGradient colors={[brand.maroonLight, brand.maroon, brand.maroonDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[{ borderRadius: 28, borderCurve: 'continuous', padding: 24, height: 190, justifyContent: 'space-between' }, shadow(t, 3), { shadowColor: brand.maroon }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900' }}>Kaser</Text>
              <Ionicons name="wifi" size={22} color="rgba(255,255,255,0.7)" style={{ transform: [{ rotate: '90deg' }] }} />
            </View>
            <View>
              <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13 }}>{tr('walletTitle')}</Text>
              <Text style={{ color: '#fff', fontSize: 40, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{money(wallet, lang, true)}</Text>
            </View>
          </LinearGradient>
        </Animated.View>

        <Card delay={80} style={{ padding: 16, gap: 12 }}>
          <Txt variant="headline">{tr('topUpAmount')}</Txt>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {[50, 100, 200, 500].map((x) => <Chip key={x} label={money(x, lang)} active={amt === x} onPress={() => setAmt(x)} />)}
          </View>
          <Button title={`${tr('topUp')} · ${money(amt, lang)}`} icon="add-circle" onPress={() => { haptic.success(); topUp(amt); }} />
        </Card>

        <Txt variant="title3">{tr('transactions')}</Txt>
        {tx.length === 0 ? <Empty emoji="🧾" title={tr('noTx')} body="" /> : (
          <Card>
            {tx.slice(0, 30).map((x, i) => (
              <View key={x.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: i < Math.min(tx.length, 30) - 1 ? 0.5 : 0, borderColor: t.separator }}>
                <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: x.amount > 0 ? t.successTint : t.fill, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name={x.kind === 'cashback' ? 'gift' : x.amount > 0 ? 'arrow-down' : 'bag-handle'} size={18} color={x.amount > 0 ? t.success : t.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Txt variant="callout" style={{ fontWeight: '600' }}>{title(x.kind)}</Txt>
                  <Txt variant="footnote" color="secondary">{dateLabel(x.at, lang)}</Txt>
                </View>
                <Txt variant="callout" color={x.amount > 0 ? 'success' : undefined} style={{ fontWeight: '800' }}>{x.amount > 0 ? '+' : '−'}{money(Math.abs(x.amount), lang, true)}</Txt>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </View>
  );
}
