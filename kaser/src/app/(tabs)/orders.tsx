import React, { useState } from 'react';
import { I18nManager, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, LinearTransition, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Art, Badge, Button, Card, Empty, Tap, Txt, haptic } from '@/components/ui';
import { TAB_BAR_HEIGHT } from '@/components/TabBar';
import { useT } from '@/i18n';
import { useStore, type Order } from '@/store';
import { vendorById } from '@/data/vendors';
import { dateLabel, money } from '@/lib/format';
import { minutesLeft, progressOf, stageOf } from '@/lib/orders';
import { reorder } from '@/lib/reorder';
import { useNow } from '@/lib/useNow';
import { radius, useTheme } from '@/theme';

function Segmented({ value, onChange, items }: { value: number; onChange: (n: number) => void; items: string[] }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const a = useAnimatedStyle(() => ({ transform: [{ translateX: withSpring((I18nManager.isRTL ? -1 : 1) * value * ((w - 6) / items.length), { damping: 18, stiffness: 220 }) }] }));
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={[styles.seg, { backgroundColor: t.fill }]}>
      {w > 0 ? <Animated.View style={[styles.segThumb, { width: (w - 6) / items.length, backgroundColor: t.card }, a]} /> : null}
      {items.map((s, i) => (
        <Tap key={s} style={{ flex: 1 }} onPress={() => { haptic.select(); onChange(i); }} feedback={false} scale={0.97}>
          <View style={{ height: 36, alignItems: 'center', justifyContent: 'center' }}>
            <Txt variant="subhead" style={{ fontWeight: '700', color: value === i ? t.text : t.textSecondary }}>{s}</Txt>
          </View>
        </Tap>
      ))}
    </View>
  );
}

function OrderCard({ o, i, now }: { o: Order; i: number; now: number }) {
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const v = vendorById(o.vendorId)!;
  const stage = stageOf(o, now);
  const active = o.status === 'active' && stage < 4;
  const prog = progressOf(o, now);
  return (
    <Animated.View entering={FadeInDown.delay(i * 50).springify().damping(18)} layout={LinearTransition.springify()}>
      <Card onPress={() => router.push(active ? `/tracking/${o.id}` : `/order/${o.id}`)} style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Art emoji={v.emoji} colors={v.colors} size={52} radiusPx={16} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="headline" numberOfLines={1}>{l(v.name)}</Txt>
            <Txt variant="footnote" color="secondary">{dateLabel(o.createdAt, lang)} · {o.lines.reduce((n, x) => n + x.qty, 0)} {tr('items')}</Txt>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Txt variant="callout" style={{ fontWeight: '800' }}>{money(o.totals.total, lang, true)}</Txt>
            {o.status === 'cancelled' ? <Badge text={tr('cancelled')} tone="neutral" /> : active ? <Badge text={`${minutesLeft(o, now)} ${tr('min')}`} icon="time" /> : <Badge text={tr('st_delivered')} tone="success" icon="checkmark-circle" />}
          </View>
        </View>
        {active ? (
          <View style={{ gap: 8 }}>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: t.fill, overflow: 'hidden' }}>
              <View style={{ width: `${Math.max(6, prog * 100)}%`, height: '100%', backgroundColor: t.primary, borderRadius: 3 }} />
            </View>
            <Txt variant="footnote" color="secondary">{tr(['st_placed', 'st_preparing', 'st_pickup', 'st_onway', 'st_delivered'][stage] as any)}</Txt>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title={tr('reorder')} icon="refresh" small variant="secondary" style={{ flex: 1 }} onPress={() => reorder(o.id)} />
          </View>
        )}
      </Card>
    </Animated.View>
  );
}

export default function Orders() {
  const t = useTheme();
  const { t: tr } = useT();
  const insets = useSafeAreaInsets();
  const orders = useStore((s) => s.orders);
  const now = useNow(1000);
  const [tab, setTab] = useState(0);
  const activeList = orders.filter((o) => o.status === 'active' && stageOf(o, now) < 4);
  const pastList = orders.filter((o) => !activeList.includes(o));
  const list = tab === 0 ? activeList : pastList;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 20, paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 100, gap: 14 }} showsVerticalScrollIndicator={false}>
        <Txt variant="largeTitle">{tr('ordersTitle')}</Txt>
        <Segmented value={tab} onChange={setTab} items={[`${tr('active')}${activeList.length ? ` (${activeList.length})` : ''}`, tr('past')]} />
        {list.length === 0 ? <Empty emoji={tab === 0 ? '🧾' : '📦'} title={tr('noOrders')} body={tr('noOrdersBody')} action={tr('browse')} onAction={() => router.navigate('/(tabs)')} /> : list.map((o, i) => <OrderCard key={o.id} o={o} i={i} now={now} />)}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  seg: { height: 42, borderRadius: radius.md, padding: 3, flexDirection: 'row' },
  segThumb: { position: 'absolute', top: 3, start: 3, height: 36, borderRadius: 13, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
});
