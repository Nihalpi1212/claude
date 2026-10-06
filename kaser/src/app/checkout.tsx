import { rise } from '@/lib/motion';
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Chevron, Chip, Tap, Txt, haptic } from '@/components/ui';
import { Header } from '@/components/Header';
import { SummaryRow } from './cart';
import { useT } from '@/i18n';
import { useCartTotals, useStore, type DeliveryMode, type PaymentMethod } from '@/store';
import { areas } from '@/data/catalog';
import { vendorById } from '@/data/vendors';
import { findItem, findPromo, optionText, unitPrice, computeTotals } from '@/lib/pricing';
import { money, pad } from '@/lib/format';
import { Platform } from 'react-native';
import { radius, useTheme } from '@/theme';

const slots = () => {
  const out: { ts: number; label: string }[] = [];
  const d = new Date();
  d.setMinutes(Math.ceil((d.getMinutes() + 45) / 30) * 30, 0, 0);
  for (let i = 0; i < 8; i++) {
    out.push({ ts: d.getTime(), label: `${pad(d.getHours())}:${pad(d.getMinutes())}` });
    d.setMinutes(d.getMinutes() + 30);
  }
  return out;
};

export default function Checkout() {
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const insets = useSafeAreaInsets();
  const cart = useStore((s) => s.cart);
  const promoCode = useStore((s) => s.promoCode);
  const tip = useStore((s) => s.tip);
  const plus = useStore((s) => !!s.plus);
  const addresses = useStore((s) => s.addresses);
  const selectedId = useStore((s) => s.selectedAddressId);
  const wallet = useStore((s) => s.wallet);
  const placeOrder = useStore((s) => s.placeOrder);
  const [mode, setMode] = useState<DeliveryMode>('standard');
  const [slot, setSlot] = useState<number | null>(null);
  const [pay, setPay] = useState<PaymentMethod>(Platform.OS === 'ios' ? 'applepay' : 'googlepay');
  const [notes, setNotes] = useState('');
  const [door, setDoor] = useState(false);
  const [busy, setBusy] = useState(false);
  const slotList = useMemo(slots, []);
  const base = useCartTotals(false);

  const address = addresses.find((a) => a.id === selectedId) ?? addresses[0];
  if (!cart || !base) return null;
  const v = vendorById(cart.vendorId)!;
  const totals = computeTotals({ vendorId: cart.vendorId, lines: cart.lines, promo: promoCode ? findPromo(promoCode) : undefined, tip, plus, priority: mode === 'priority' });
  const walletShort = pay === 'wallet' && wallet < totals.total;
  const eta = mode === 'priority' ? Math.max(10, v.etaMin - 8) : Math.round((v.etaMin + v.etaMax) / 2);

  const methods: { id: PaymentMethod; icon: keyof typeof Ionicons.glyphMap; title: string; sub?: string }[] = [
    Platform.OS === 'ios' ? { id: 'applepay', icon: 'logo-apple', title: tr('applePay') } : { id: 'googlepay', icon: 'logo-google', title: tr('googlePay') },
    { id: 'card', icon: 'card', title: tr('card'), sub: 'Visa · Mastercard · NAPS' },
    { id: 'wallet', icon: 'wallet', title: tr('wallet'), sub: tr('walletBalance', { amt: money(wallet, lang, true) }) },
    { id: 'cash', icon: 'cash', title: tr('cash') },
  ];

  const submit = () => {
    if (!address || walletShort) return;
    setBusy(true);
    haptic.medium();
    setTimeout(() => {
      const id = placeOrder({
        vendorId: v.id,
        lines: cart.lines.map((ln) => {
          const it = findItem(v.id, ln.itemId)!;
          return { ...ln, name: it.name, emoji: it.emoji, unit: unitPrice(it, ln.sel), optionText: optionText(it, ln.sel) };
        }),
        totals,
        address,
        payment: pay,
        mode,
        scheduledFor: mode === 'scheduled' ? slot ?? slotList[0].ts : undefined,
        notes: notes.trim(),
        leaveAtDoor: door,
        etaMinutes: eta,
        promo: promoCode,
      });
      haptic.success();
      router.dismissAll();
      router.replace('/(tabs)');
      setTimeout(() => router.push(`/tracking/${id}`), 60);
    }, 900);
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header title={tr('checkout')} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 160, gap: 18 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Address */}
        <Section title={tr('deliveryAddress')}>
          <Card onPress={() => router.push('/addresses')} style={{ padding: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={[styles.icon, { backgroundColor: t.primaryTint }]}><Ionicons name="location" size={20} color={t.primaryText} /></View>
              <View style={{ flex: 1 }}>
                {address ? (
                  <>
                    <Txt variant="callout" style={{ fontWeight: '700' }}>{tr(address.label)} · {l(areas.find((a) => a.id === address.area)!.name)}</Txt>
                    <Txt variant="footnote" color="secondary" numberOfLines={2}>
                      {tr('building')} {address.building}, {tr('street')} {address.street}, {tr('zone')} {address.zone}{address.unit ? `, ${address.unit}` : ''}
                    </Txt>
                  </>
                ) : <Txt variant="callout" color="primary" style={{ fontWeight: '700' }}>{tr('noAddress')}</Txt>}
              </View>
              <Txt variant="subhead" color="primary" style={{ fontWeight: '600' }}>{tr('noteChange')}</Txt>
            </View>
          </Card>
        </Section>

        {/* Delivery time */}
        <Section title={tr('deliveryOption')}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {([['standard', tr('asap'), `${v.etaMin}–${v.etaMax} ${tr('min')}`, 'bicycle'], ['priority', tr('priority'), `+${money(4, lang)}`, 'flash'], ['scheduled', tr('scheduled'), '', 'calendar']] as const).map(([id, title, sub, icon]) => {
              const on = mode === id;
              return (
                <Tap key={id} style={{ flex: 1 }} onPress={() => { haptic.select(); setMode(id); }} scale={0.95} feedback={false}>
                  <View style={[styles.mode, { backgroundColor: on ? t.primary : t.card, borderColor: on ? t.primary : t.separator }]}>
                    <Ionicons name={icon} size={20} color={on ? t.onPrimary : t.primaryText} />
                    <Text style={{ color: on ? t.onPrimary : t.text, fontWeight: '800', fontSize: 14 }}>{title}</Text>
                    {sub ? <Text style={{ color: on ? t.onPrimary : t.textSecondary, opacity: on ? 0.8 : 1, fontSize: 11 }}>{sub}</Text> : null}
                  </View>
                </Tap>
              );
            })}
          </View>
          {mode === 'scheduled' ? (
            <Animated.View entering={rise()}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 12 }}>
                {slotList.map((s) => <Chip key={s.ts} label={s.label} active={(slot ?? slotList[0].ts) === s.ts} onPress={() => setSlot(s.ts)} />)}
              </ScrollView>
            </Animated.View>
          ) : null}
        </Section>

        {/* Payment */}
        <Section title={tr('paymentMethod')}>
          <Card>
            {methods.map((m, i) => {
              const on = pay === m.id;
              return (
                <View key={m.id}>
                  <Tap onPress={() => { haptic.select(); setPay(m.id); }} scale={0.99} feedback={false}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
                      <View style={[styles.icon, { backgroundColor: t.fill }]}><Ionicons name={m.icon} size={20} color={t.text} /></View>
                      <View style={{ flex: 1 }}>
                        <Txt variant="callout" style={{ fontWeight: '600' }}>{m.title}</Txt>
                        {m.sub ? <Txt variant="footnote" color="secondary">{m.sub}</Txt> : null}
                      </View>
                      <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? t.primary : t.textTertiary} />
                    </View>
                  </Tap>
                  {i < methods.length - 1 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator, marginStart: 62 }} /> : null}
                </View>
              );
            })}
          </Card>
          {walletShort ? <Txt variant="footnote" color="danger" style={{ marginTop: 8 }}>{tr('insufficientWallet')}</Txt> : null}
        </Section>

        {/* Notes */}
        <Section title={tr('deliveryNotes')}>
          <Card style={{ padding: 14, gap: 10 }}>
            <TextInput value={notes} onChangeText={setNotes} placeholder={tr('notesPlaceholder')} placeholderTextColor={t.textTertiary} multiline style={{ minHeight: 56, fontSize: 16, color: t.text, textAlignVertical: 'top' }} />
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="hand-left-outline" size={18} color={t.textSecondary} />
                <Txt variant="callout">{tr('contactless')}</Txt>
              </View>
              <Switch value={door} onValueChange={(x) => { haptic.select(); setDoor(x); }} trackColor={{ true: t.primary }} />
            </View>
          </Card>
        </Section>

        {/* Summary */}
        <Section title={tr('orderSummary')}>
          <Card style={{ padding: 16, gap: 10 }}>
            {cart.lines.map((ln) => {
              const it = findItem(v.id, ln.itemId)!;
              return (
                <View key={ln.key} style={{ flexDirection: 'row', gap: 10 }}>
                  <Txt variant="subhead" color="secondary" style={{ width: 28 }}>{ln.qty}×</Txt>
                  <Txt variant="subhead" style={{ flex: 1 }} numberOfLines={1}>{l(it.name)}</Txt>
                  <Txt variant="subhead" style={{ fontWeight: '600' }}>{money(unitPrice(it, ln.sel) * ln.qty, lang)}</Txt>
                </View>
              );
            })}
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator }} />
            <SummaryRow label={tr('subtotal')} value={money(totals.subtotal, lang, true)} />
            <SummaryRow label={tr('deliveryFee')} value={totals.deliveryFee === 0 ? tr('freeDelivery') : money(totals.deliveryFee, lang, true)} good={totals.deliveryFee === 0} />
            {totals.serviceFee > 0 ? <SummaryRow label={tr('serviceFee')} value={money(totals.serviceFee, lang, true)} /> : null}
            {totals.priorityFee > 0 ? <SummaryRow label={tr('priority')} value={money(totals.priorityFee, lang, true)} /> : null}
            {totals.discount > 0 ? <SummaryRow label={tr('discount')} value={`−${money(totals.discount, lang, true)}`} good /> : null}
            {totals.tip > 0 ? <SummaryRow label={tr('tip')} value={money(totals.tip, lang, true)} /> : null}
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator }} />
            <SummaryRow label={tr('total')} value={money(totals.total, lang, true)} bold />
          </Card>
        </Section>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12, backgroundColor: t.bg, borderColor: t.separator }]}>
        <Button
          icon={pay === 'applepay' ? 'logo-apple' : undefined}
          title={busy ? tr('placing') : `${tr('placeOrder')} · ${money(totals.total, lang, true)}`}
          loading={busy}
          disabled={!address || walletShort}
          onPress={submit}
        />
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Animated.View entering={rise()}>
      <Txt variant="title3" style={{ marginBottom: 10 }}>{title}</Txt>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  icon: { width: 40, height: 40, borderRadius: 12, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
  mode: { alignItems: 'center', gap: 4, paddingVertical: 14, borderRadius: radius.lg, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, minHeight: 92, justifyContent: 'center' },
  footer: { position: 'absolute', bottom: 0, start: 0, end: 0, paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
