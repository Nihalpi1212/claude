import React from 'react';
import { Alert, Dimensions, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, ZoomIn } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Art, BackGlyph, Button, Card, GlassCircle, Tap, Txt, haptic } from '@/components/ui';
import { Steps, useStatusText } from '@/components/OrderBits';
import { TrackingMap } from '@/components/TrackingMap';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { couriers } from '@/data/catalog';
import { vendorById } from '@/data/vendors';
import { minutesLeft, progressOf, routeProgress, stageOf } from '@/lib/orders';
import { useNow } from '@/lib/useNow';
import { money, timeLabel } from '@/lib/format';
import { radius, shadow, useTheme } from '@/theme';

const { width: W, height: H } = Dimensions.get('window');
const MAP_H = Math.round(H * 0.46);

export default function Tracking() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const insets = useSafeAreaInsets();
  const order = useStore((s) => s.orders.find((o) => o.id === id));
  const cancel = useStore((s) => s.cancelOrder);
  const rate = useStore((s) => s.rateOrder);
  const now = useNow(1000);
  const courier = couriers[order?.courierIdx ?? 0];
  const stage = order ? (order.status === 'cancelled' ? 0 : stageOf(order, now)) : 0;
  const status = useStatusText(stage, l(courier.name));
  if (!order) return null;
  const v = vendorById(order.vendorId)!;
  const cancelled = order.status === 'cancelled';
  const done = stage === 4 && !cancelled;
  const left = minutesLeft(order, now);
  const arrival = timeLabel(order.createdAt + order.etaMinutes * 60000, lang);

  const doCancel = () =>
    Alert.alert(tr('cancelConfirm'), undefined, [
      { text: tr('cancel'), style: 'cancel' },
      { text: tr('cancelOrder'), style: 'destructive', onPress: () => { haptic.success(); cancel(order.id); } },
    ]);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ height: MAP_H }}>
        <TrackingMap width={W} height={MAP_H} progress={routeProgress(order, now)} stage={stage} />
        <View style={[styles.nav, { top: insets.top + 8 }]}>
          <GlassCircle onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}><BackGlyph /></GlassCircle>
          <GlassCircle onPress={() => router.push('/help')}><Ionicons name="help-circle-outline" size={22} color={t.text} /></GlassCircle>
        </View>
      </View>

      <Animated.View entering={FadeInDown.springify().damping(18)} style={[styles.sheet, { backgroundColor: t.bg }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 16 }}>
          <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: t.separator, marginBottom: -4 }} />
          {cancelled ? (
            <View style={{ alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 44 }}>🚫</Text>
              <Txt variant="title2">{tr('cancelled')}</Txt>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="footnote" color="secondary">{done ? tr('etaDone') : tr('eta')}</Txt>
                {done ? (
                  <Animated.View entering={ZoomIn.springify()}><Txt variant="title1">✅ {tr('st_delivered')}</Txt></Animated.View>
                ) : (
                  <Txt variant="largeTitle" style={{ fontVariant: ['tabular-nums'] }}>{left} <Txt variant="title3" color="secondary">{tr('min')}</Txt></Txt>
                )}
                {!done ? <Txt variant="footnote" color="secondary">{arrival}</Txt> : null}
              </View>
              <Txt variant="footnote" color="secondary">{tr('orderNumber', { id: order.id })}</Txt>
            </View>
          )}

          {!cancelled ? (
            <Card style={{ padding: 16, gap: 14 }}>
              <Steps stage={stage} />
              <Animated.View key={stage} entering={FadeIn.duration(300)}>
                <Txt variant="headline">{status.title}</Txt>
                <Txt variant="subhead" color="secondary" style={{ marginTop: 2 }}>{status.desc}</Txt>
              </Animated.View>
            </Card>
          ) : null}

          {stage >= 2 && !cancelled ? (
            <Card style={{ padding: 16 }} delay={0}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={[styles.avatar, { backgroundColor: t.primaryTint }]}><Text style={{ fontSize: 26 }}>🧑</Text></View>
                <View style={{ flex: 1 }}>
                  <Txt variant="caption" color="secondary">{tr('yourCourier')}</Txt>
                  <Txt variant="headline">{l(courier.name)}</Txt>
                  <Txt variant="footnote" color="secondary">⭐ {courier.rating} · {l(courier.vehicle)} · {courier.plate}</Txt>
                </View>
                <Tap onPress={() => Linking.openURL('sms:+97455501234')}><View style={[styles.round, { backgroundColor: t.fill }]}><Ionicons name="chatbubble" size={19} color={t.text} /></View></Tap>
                <Tap onPress={() => Linking.openURL('tel:+97455501234')}><View style={[styles.round, { backgroundColor: t.success }]}><Ionicons name="call" size={19} color="#fff" /></View></Tap>
              </View>
            </Card>
          ) : null}

          <Card style={{ padding: 16, gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Art emoji={v.emoji} colors={v.colors} size={44} radiusPx={14} />
              <View style={{ flex: 1 }}>
                <Txt variant="headline">{l(v.name)}</Txt>
                <Txt variant="footnote" color="secondary">{order.lines.reduce((n, x) => n + x.qty, 0)} {tr('items')} · {money(order.totals.total, lang, true)}</Txt>
              </View>
            </View>
            {order.lines.map((ln) => (
              <View key={ln.key} style={{ flexDirection: 'row', gap: 8 }}>
                <Txt variant="subhead" color="secondary" style={{ width: 28 }}>{ln.qty}×</Txt>
                <Txt variant="subhead" style={{ flex: 1 }}>{l(ln.name)}</Txt>
              </View>
            ))}
          </Card>

          {done && !order.rating ? (
            <Card style={{ padding: 16, alignItems: 'center', gap: 10 }}>
              <Txt variant="headline">{tr('rateOrder')}</Txt>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Tap key={n} scale={0.8} onPress={() => { haptic.success(); rate(order.id, n); }}>
                    <Ionicons name="star-outline" size={36} color={t.star} />
                  </Tap>
                ))}
              </View>
            </Card>
          ) : null}
          {done && order.rating ? (
            <Card style={{ padding: 16, alignItems: 'center', gap: 6 }}>
              <View style={{ flexDirection: 'row', gap: 4 }}>{[1, 2, 3, 4, 5].map((n) => <Ionicons key={n} name={n <= order.rating! ? 'star' : 'star-outline'} size={26} color={t.star} />)}</View>
              <Txt variant="subhead" color="secondary">{tr('thanks')}</Txt>
            </Card>
          ) : null}

          {stage <= 1 && !cancelled ? <Button variant="danger" title={tr('cancelOrder')} onPress={doCancel} /> : null}
          {(done || cancelled) ? <Button title={tr('backHome')} onPress={() => router.replace('/(tabs)')} /> : null}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { position: 'absolute', start: 16, end: 16, flexDirection: 'row', justifyContent: 'space-between' },
  sheet: { flex: 1, marginTop: -28, borderTopStartRadius: 30, borderTopEndRadius: 30, borderCurve: 'continuous', overflow: 'hidden' },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  round: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
});
