import { rise } from '@/lib/motion';
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { RingPattern } from '@/components/Brand';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Chip, Empty, Txt, haptic } from '@/components/ui';
import { Header } from '@/components/Header';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { dateLabel, money } from '@/lib/format';
import { brand, radius, useTheme } from '@/theme';

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
        <Animated.View entering={rise()}>
          <View style={[{ borderRadius: radius.xl, borderCurve: 'continuous', padding: 24, height: 190, justifyContent: 'space-between', backgroundColor: brand.orange, overflow: 'hidden' }]}>
            <RingPattern width={400} height={220} opacity={0.14} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: brand.ink, fontSize: 22, fontWeight: '900', letterSpacing: 1 }}>KASER</Text>
              <Ionicons name="wallet" size={24} color={brand.ink} />
            </View>
            <View>
              <Text style={{ color: brand.ink, opacity: 0.75, fontSize: 13, fontWeight: '600' }}>{tr('walletTitle')}</Text>
              <Text style={{ color: brand.ink, fontSize: 40, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{money(wallet, lang, true)}</Text>
            </View>
          </View>
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
