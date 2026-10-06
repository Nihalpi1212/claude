import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Art, Badge, Button, Card, Txt } from '@/components/ui';
import { Header } from '@/components/Header';
import { SummaryRow } from '../cart';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { areas } from '@/data/catalog';
import { vendorById } from '@/data/vendors';
import { dateLabel, money, timeLabel } from '@/lib/format';
import { reorder } from '@/lib/reorder';
import { useTheme } from '@/theme';

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const insets = useSafeAreaInsets();
  const o = useStore((s) => s.orders.find((x) => x.id === id));
  if (!o) return null;
  const v = vendorById(o.vendorId)!;
  const pay = { applepay: tr('applePay'), googlepay: tr('googlePay'), card: tr('card'), cash: tr('cash'), wallet: tr('wallet') }[o.payment];
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header title={tr('orderNumber', { id: o.id })} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: insets.bottom + 120 }} showsVerticalScrollIndicator={false}>
        <Card style={{ padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Art emoji={v.emoji} colors={v.colors} size={52} radiusPx={16} />
            <View style={{ flex: 1 }}>
              <Txt variant="headline">{l(v.name)}</Txt>
              <Txt variant="footnote" color="secondary">{dateLabel(o.createdAt, lang)} · {timeLabel(o.createdAt, lang)}</Txt>
            </View>
            <Badge text={o.status === 'cancelled' ? tr('cancelled') : o.status === 'delivered' ? tr('st_delivered') : tr('active')} tone={o.status === 'delivered' ? 'success' : o.status === 'cancelled' ? 'neutral' : 'primary'} />
          </View>
        </Card>
        <Card style={{ padding: 16, gap: 10 }}>
          {o.lines.map((ln) => (
            <View key={ln.key} style={{ flexDirection: 'row', gap: 8 }}>
              <Txt variant="subhead" color="secondary" style={{ width: 28 }}>{ln.qty}×</Txt>
              <View style={{ flex: 1 }}>
                <Txt variant="subhead">{l(ln.name)}</Txt>
                {ln.optionText[lang] ? <Txt variant="caption" color="secondary">{ln.optionText[lang]}</Txt> : null}
              </View>
              <Txt variant="subhead" style={{ fontWeight: '600' }}>{money(ln.unit * ln.qty, lang)}</Txt>
            </View>
          ))}
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator }} />
          <SummaryRow label={tr('subtotal')} value={money(o.totals.subtotal, lang, true)} />
          <SummaryRow label={tr('deliveryFee')} value={o.totals.deliveryFee === 0 ? tr('freeDelivery') : money(o.totals.deliveryFee, lang, true)} good={o.totals.deliveryFee === 0} />
          {o.totals.serviceFee > 0 ? <SummaryRow label={tr('serviceFee')} value={money(o.totals.serviceFee, lang, true)} /> : null}
          {o.totals.discount > 0 ? <SummaryRow label={tr('discount')} value={`−${money(o.totals.discount, lang, true)}`} good /> : null}
          {o.totals.tip > 0 ? <SummaryRow label={tr('tip')} value={money(o.totals.tip, lang, true)} /> : null}
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator }} />
          <SummaryRow label={tr('total')} value={money(o.totals.total, lang, true)} bold />
        </Card>
        <Card style={{ padding: 16, gap: 8 }}>
          <Txt variant="footnote" color="secondary">{tr('deliveryAddress')}</Txt>
          <Txt variant="callout" style={{ fontWeight: '600' }}>{tr(o.address.label)} · {l(areas.find((a) => a.id === o.address.area)!.name)}</Txt>
          <Txt variant="footnote" color="secondary">{tr('building')} {o.address.building}, {tr('street')} {o.address.street}, {tr('zone')} {o.address.zone}</Txt>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator, marginVertical: 4 }} />
          <Txt variant="footnote" color="secondary">{tr('paymentMethod')}</Txt>
          <Txt variant="callout" style={{ fontWeight: '600' }}>{pay}</Txt>
        </Card>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12, backgroundColor: t.bg, borderColor: t.separator }]}>
        {o.status === 'active' ? <Button title={tr('trackOrder')} icon="navigate" onPress={() => router.replace(`/tracking/${o.id}`)} /> : <Button title={tr('reorder')} icon="refresh" onPress={() => reorder(o.id)} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ footer: { position: 'absolute', bottom: 0, start: 0, end: 0, paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth } });
