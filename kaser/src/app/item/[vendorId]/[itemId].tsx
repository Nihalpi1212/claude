import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Art, Badge, Button, GlassCircle, Stepper, Tap, Txt, haptic } from '@/components/ui';
import { useT } from '@/i18n';
import { vendorById, isOpen } from '@/data/vendors';
import { findItem, unitPrice } from '@/lib/pricing';
import { addToCartSafe } from '@/lib/cartActions';
import { money } from '@/lib/format';
import { radius, shadow, useTheme } from '@/theme';

export default function ItemSheet() {
  const { vendorId, itemId } = useLocalSearchParams<{ vendorId: string; itemId: string }>();
  const v = vendorById(vendorId);
  const item = findItem(vendorId, itemId);
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const insets = useSafeAreaInsets();
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [sel, setSel] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const g of item?.groups ?? []) if (g.required && g.max === 1) init[g.id] = [g.options[0].id];
    return init;
  });

  const unit = useMemo(() => (item ? unitPrice(item, sel) : 0), [item, sel]);
  if (!v || !item) return null;
  const valid = (item.groups ?? []).every((g) => !g.required || (sel[g.id]?.length ?? 0) >= 1);
  const open = isOpen(v);

  const toggle = (gid: string, oid: string, max: number) => {
    haptic.select();
    setSel((s) => {
      const cur = s[gid] ?? [];
      if (max === 1) return { ...s, [gid]: [oid] };
      if (cur.includes(oid)) return { ...s, [gid]: cur.filter((x) => x !== oid) };
      if (cur.length >= max) return s;
      return { ...s, [gid]: [...cur, oid] };
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }} showsVerticalScrollIndicator={false}>
        <Art emoji={item.emoji} colors={v.colors} radiusPx={0} style={{ height: 240 }} />
        <View style={{ padding: 20, gap: 8 }}>
          <Txt variant="title1">{l(item.name)}</Txt>
          {item.popular ? <Badge text={tr('popular')} icon="flame" tone="warning" /> : null}
          <Txt variant="callout" color="secondary">{l(item.desc)}</Txt>
          <Txt variant="title3" style={{ marginTop: 4 }}>{money(item.price, lang)}</Txt>
        </View>

        {(item.groups ?? []).map((g, gi) => (
          <Animated.View key={g.id} entering={FadeInDown.delay(gi * 60).springify().damping(18)} style={{ marginHorizontal: 20, marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Txt variant="headline">{l(g.title)}</Txt>
              <Badge text={g.required ? tr('required') : g.max > 1 ? `${tr('optional')} · ${g.max}` : tr('optional')} tone={g.required ? 'primary' : 'neutral'} />
            </View>
            <View style={[{ backgroundColor: t.card, borderRadius: radius.lg, borderCurve: 'continuous', overflow: 'hidden' }, shadow(t, 1)]}>
              {g.options.map((o, oi) => {
                const on = sel[g.id]?.includes(o.id);
                return (
                  <View key={o.id}>
                    <Tap onPress={() => toggle(g.id, o.id, g.max)} scale={0.99} feedback={false}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }}>
                        <View style={[g.max === 1 ? styles.radio : styles.check, { borderColor: on ? t.primary : t.textTertiary, backgroundColor: on ? t.primary : 'transparent' }]}>
                          {on ? <Ionicons name={g.max === 1 ? 'ellipse' : 'checkmark'} size={g.max === 1 ? 10 : 15} color="#fff" /> : null}
                        </View>
                        <Txt variant="callout" style={{ flex: 1, fontWeight: on ? '700' : '400' }}>{l(o.name)}</Txt>
                        {o.price > 0 ? <Txt variant="subhead" color="secondary">+{money(o.price, lang)}</Txt> : null}
                      </View>
                    </Tap>
                    {oi < g.options.length - 1 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator, marginStart: 52 }} /> : null}
                  </View>
                );
              })}
            </View>
          </Animated.View>
        ))}

        <View style={{ marginHorizontal: 20 }}>
          <Txt variant="headline" style={{ marginBottom: 8 }}>{tr('specialInstructions')}</Txt>
          <TextInput value={note} onChangeText={setNote} placeholder={tr('specialPlaceholder')} placeholderTextColor={t.textTertiary} multiline style={[styles.note, { backgroundColor: t.card, color: t.text }]} />
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12, backgroundColor: t.bg, borderColor: t.separator }]}>
        <Stepper qty={qty} onChange={setQty} min={1} />
        <Button
          style={{ flex: 1 }}
          title={`${tr('addToCart')} · ${money(unit * qty, lang)}`}
          disabled={!valid || !open}
          onPress={() => {
            const ok = addToCartSafe(v.id, { itemId: item.id, qty, sel, note: note.trim() || undefined }, () => { haptic.success(); router.back(); });
            void ok;
          }}
        />
      </View>
      <View style={[styles.close, { top: 14 }]}><GlassCircle onPress={() => router.back()}><Ionicons name="close" size={22} color={t.text} /></GlassCircle></View>
    </View>
  );
}

const styles = StyleSheet.create({
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  check: { width: 24, height: 24, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  note: { minHeight: 80, borderRadius: radius.lg, borderCurve: 'continuous', padding: 14, fontSize: 16, textAlignVertical: 'top' },
  footer: { position: 'absolute', bottom: 0, start: 0, end: 0, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  close: { position: 'absolute', end: 16 },
});
