import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Art, Badge, Button, Card, Chip, Empty, Stepper, Tap, Txt, haptic } from '@/components/ui';
import { Header } from '@/components/Header';
import { useT } from '@/i18n';
import { useCartTotals, useStore } from '@/store';
import { vendorById } from '@/data/vendors';
import { findItem, findPromo, optionText, unitPrice } from '@/lib/pricing';
import { money } from '@/lib/format';
import { radius, useTheme } from '@/theme';

export const TIPS = [0, 2, 5, 10];

export function SummaryRow({ label, value, bold, good }: { label: string; value: string; bold?: boolean; good?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Txt variant={bold ? 'headline' : 'subhead'} color={bold ? undefined : 'secondary'}>{label}</Txt>
      <Txt variant={bold ? 'title3' : 'subhead'} color={good ? 'success' : undefined} style={{ fontWeight: bold ? '800' : '600' }}>{value}</Txt>
    </View>
  );
}

export default function Cart() {
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const insets = useSafeAreaInsets();
  const cart = useStore((s) => s.cart);
  const promoCode = useStore((s) => s.promoCode);
  const tip = useStore((s) => s.tip);
  const setTip = useStore((s) => s.setTip);
  const setPromo = useStore((s) => s.setPromo);
  const setQty = useStore((s) => s.setQty);
  const clearCart = useStore((s) => s.clearCart);
  const totals = useCartTotals();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!cart || !totals) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <Header close title={tr('cart')} noTop />
        <Empty emoji="🛒" title={tr('cartEmpty')} body={tr('cartEmptyBody')} action={tr('browse')} onAction={() => router.back()} />
      </View>
    );
  }
  const v = vendorById(cart.vendorId)!;
  const belowMin = totals.subtotal < v.minOrder;

  const applyCode = () => {
    const p = findPromo(code);
    if (!p) { haptic.error(); setMsg({ ok: false, text: tr('promoInvalid') }); return; }
    if (totals.subtotal < p.minSubtotal) { haptic.error(); setMsg({ ok: false, text: tr('promoMin', { min: p.minSubtotal }) }); return; }
    haptic.success();
    setPromo(p.code);
    setMsg({ ok: true, text: tr('promoApplied') });
    setCode('');
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header close title={tr('cart')} noTop right={<Tap onPress={() => { clearCart(); router.back(); }}><Txt variant="subhead" color="danger" style={{ fontWeight: '600' }}>{tr('clearCart')}</Txt></Tap>} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 160, gap: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Animated.View entering={FadeInDown.springify().damping(18)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Art emoji={v.emoji} colors={v.colors} size={48} radiusPx={16} />
          <View style={{ flex: 1 }}>
            <Txt variant="headline">{l(v.name)}</Txt>
            <Txt variant="footnote" color="secondary">{v.etaMin}–{v.etaMax} {tr('min')}</Txt>
          </View>
        </Animated.View>

        <Card style={{ padding: 4 }}>
          {cart.lines.map((line, i) => {
            const item = findItem(cart.vendorId, line.itemId);
            if (!item) return null;
            const opt = optionText(item, line.sel);
            return (
              <Animated.View key={line.key} layout={LinearTransition.springify().damping(18)} exiting={FadeOut.duration(160)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }}>
                  <Art emoji={item.emoji} colors={v.colors} size={56} radiusPx={16} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt variant="callout" numberOfLines={2} style={{ fontWeight: '700' }}>{l(item.name)}</Txt>
                    {opt[lang] ? <Txt variant="caption" color="secondary" numberOfLines={2}>{opt[lang]}</Txt> : null}
                    {line.note ? <Txt variant="caption" color="tertiary" numberOfLines={1}>“{line.note}”</Txt> : null}
                    <Txt variant="subhead" style={{ fontWeight: '800', marginTop: 2 }}>{money(unitPrice(item, line.sel) * line.qty, lang)}</Txt>
                  </View>
                  <Stepper qty={line.qty} onChange={(n) => setQty(line.key, n)} small />
                </View>
                {i < cart.lines.length - 1 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator, marginStart: 80 }} /> : null}
              </Animated.View>
            );
          })}
        </Card>

        <Tap onPress={() => router.back()} scale={0.97}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 4 }}>
            <Ionicons name="add-circle" size={20} color={t.primary} />
            <Txt variant="callout" color="primary" style={{ fontWeight: '700' }}>{tr('addMore')}</Txt>
          </View>
        </Tap>

        {/* Promo */}
        <Card style={{ padding: 16, gap: 10 }}>
          <Txt variant="headline">{tr('promoCode')}</Txt>
          {promoCode ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Badge text={promoCode} tone="success" icon="checkmark-circle" />
              <Txt variant="footnote" color="success" style={{ flex: 1 }}>{totals.discount > 0 ? `−${money(totals.discount, lang)}` : tr('promoApplied')}</Txt>
              <Tap onPress={() => { setPromo(undefined); setMsg(null); }}><Txt variant="subhead" color="danger" style={{ fontWeight: '600' }}>{tr('remove')}</Txt></Tap>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TextInput value={code} onChangeText={(x) => { setCode(x); setMsg(null); }} autoCapitalize="characters" placeholder="WELCOME30" placeholderTextColor={t.textTertiary} style={[styles.input, { backgroundColor: t.fill, color: t.text }]} />
              <Button title={tr('apply')} small variant="secondary" onPress={applyCode} disabled={!code.trim()} />
            </View>
          )}
          {msg ? <Txt variant="footnote" color={msg.ok ? 'success' : 'danger'}>{msg.text}</Txt> : null}
        </Card>

        {/* Tip */}
        <Card style={{ padding: 16, gap: 10 }}>
          <Txt variant="headline">{tr('tip')} 🛵</Txt>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {TIPS.map((x) => <Chip key={x} label={x === 0 ? '—' : money(x, lang)} active={tip === x} onPress={() => setTip(x)} />)}
          </View>
        </Card>

        {/* Totals */}
        <Card style={{ padding: 16, gap: 10 }}>
          <SummaryRow label={tr('subtotal')} value={money(totals.subtotal, lang, true)} />
          <SummaryRow label={tr('deliveryFee')} value={totals.deliveryFee === 0 ? tr('freeDelivery') : money(totals.deliveryFee, lang, true)} good={totals.deliveryFee === 0} />
          <SummaryRow label={tr('serviceFee')} value={totals.serviceFee === 0 ? '—' : money(totals.serviceFee, lang, true)} />
          {totals.discount > 0 ? <SummaryRow label={tr('discount')} value={`−${money(totals.discount, lang, true)}`} good /> : null}
          {totals.tip > 0 ? <SummaryRow label={tr('tip')} value={money(totals.tip, lang, true)} /> : null}
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator }} />
          <SummaryRow label={tr('total')} value={money(totals.total, lang, true)} bold />
        </Card>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12, backgroundColor: t.bg, borderColor: t.separator }]}>
        {belowMin ? <Txt variant="footnote" color="danger" style={{ textAlign: 'center', marginBottom: 8 }}>{tr('belowMin', { min: v.minOrder })}</Txt> : null}
        <Button title={`${tr('checkout')} · ${money(totals.total, lang, true)}`} disabled={belowMin} onPress={() => router.push('/checkout')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  input: { flex: 1, height: 44, borderRadius: radius.md, borderCurve: 'continuous', paddingHorizontal: 14, fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  footer: { position: 'absolute', bottom: 0, start: 0, end: 0, paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
