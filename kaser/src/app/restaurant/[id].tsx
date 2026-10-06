import { rise } from '@/lib/motion';
import React, { useRef, useState } from 'react';
import { Dimensions, LayoutChangeEvent, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { Extrapolation, FadeInDown, interpolate, useAnimatedReaction, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Art, BackGlyph, Badge, Chip, GlassCircle, Stars, Tap, Txt, haptic } from '@/components/ui';
import { Heart } from '@/components/VendorCard';
import { CartBar } from '@/components/CartBar';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { fmtHour, isOpen, vendorById } from '@/data/vendors';
import { money } from '@/lib/format';
import { addToCartSafe, needsOptions } from '@/lib/cartActions';
import { radius, shadow, useTheme } from '@/theme';

const HERO = 260;

export default function Restaurant() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const v = vendorById(id);
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const insets = useSafeAreaInsets();
  const cart = useStore((s) => s.cart);
  const [active, setActive] = useState(0);
  const [stuck, setStuck] = useState(false);
  const ref = useAnimatedRef<Animated.ScrollView>();
  const y = useSharedValue(0);
  const ys = useRef<number[]>([]);
  const onScroll = useAnimatedScrollHandler((e) => { y.value = e.contentOffset.y; });

  const heroStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(y.value, [-200, 0, HERO], [-100, 0, HERO * 0.45], Extrapolation.CLAMP) },
      { scale: interpolate(y.value, [-200, 0], [1.8, 1], Extrapolation.CLAMP) },
    ],
  }));
  const STICK = HERO + 150;
  useAnimatedReaction(() => y.value > STICK, (cur, prev) => { if (cur !== prev) scheduleOnRN(setStuck, cur); });
  const stickStyle = useAnimatedStyle(() => ({ opacity: interpolate(y.value, [STICK - 30, STICK], [0, 1], Extrapolation.CLAMP) }));
  const barStyle = useAnimatedStyle(() => ({ opacity: interpolate(y.value, [HERO - 140, HERO - 80], [0, 1], Extrapolation.CLAMP) }));

  if (!v) return null;
  const open = isOpen(v);
  const itemsInCart = (itemId: string) => (cart?.vendorId === v.id ? cart.lines.filter((l2) => l2.itemId === itemId).reduce((n, l2) => n + l2.qty, 0) : 0);

  const goSection = (i: number) => {
    setActive(i);
    haptic.select();
    (ref.current as any)?.scrollTo({ y: (ys.current[i] ?? 0) - 120 - insets.top, animated: true });
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Animated.ScrollView
        ref={ref}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 140 }}
        onMomentumScrollEnd={(e) => {
          const off = e.nativeEvent.contentOffset.y + 160 + insets.top;
          let idx = 0;
          ys.current.forEach((yy, i) => { if (off >= yy) idx = i; });
          setActive(idx);
        }}
      >
        <View style={{ height: HERO, overflow: 'hidden' }}>
          <Animated.View style={[{ height: HERO + 60 }, heroStyle]}>
            <Art emoji={v.emoji} radiusPx={0} style={{ flex: 1 }} />
          </Animated.View>
        </View>

        <Animated.View entering={rise()} style={[styles.infoCard, { backgroundColor: t.card }, shadow(t, 2)]}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Txt variant="title1">{l(v.name)}</Txt>
              <Txt variant="subhead" color="secondary">{l(v.tagline)}</Txt>
            </View>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <Stars value={v.rating} size={15} />
            <Txt variant="footnote" color="secondary">({v.ratingCount.toLocaleString()})</Txt>
            <Txt variant="footnote" color="tertiary">•</Txt>
            <Txt variant="footnote" color="secondary">{l(v.cuisine)}</Txt>
          </View>
          <View style={[styles.stats, { borderColor: t.separator }]}>
            <Stat icon="time-outline" label={tr('deliveryTime')} value={`${v.etaMin}–${v.etaMax} ${tr('min')}`} />
            <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: t.separator }} />
            <Stat icon="bicycle" label={tr('delivery')} value={v.deliveryFee === 0 ? tr('freeDelivery') : money(v.deliveryFee, lang)} good={v.deliveryFee === 0} />
            <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: t.separator }} />
            <Stat icon="bag-check-outline" label={tr('minOrder')} value={money(v.minOrder, lang)} />
          </View>
          {v.promo ? <View style={{ marginTop: 12 }}><Badge text={l(v.promo)} icon="pricetag" /></View> : null}
          <Tap scale={0.98}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
              <Ionicons name={open ? 'time' : 'moon'} size={15} color={open ? t.success : t.danger} />
              <Txt variant="footnote" style={{ fontWeight: '700', color: open ? t.success : t.danger }}>{open ? tr('openNow') : tr('closed')}</Txt>
              <Txt variant="footnote" color="secondary">· {fmtHour(v.hours[0], lang)} – {fmtHour(v.hours[1], lang)}</Txt>
            </View>
          </Tap>
          {!open ? <Txt variant="footnote" color="secondary" style={{ marginTop: 8 }}>{tr('closedBody')}</Txt> : null}
        </Animated.View>

        {/* sticky section tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 8, paddingVertical: 14 }}>
          {v.menu.map((s, i) => <Chip key={s.id} label={l(s.title)} active={active === i} onPress={() => goSection(i)} />)}
        </ScrollView>

        {v.menu.map((s, si) => (
          <View key={s.id} onLayout={(e: LayoutChangeEvent) => { ys.current[si] = e.nativeEvent.layout.y; }} style={{ paddingHorizontal: 20 }}>
            <Txt variant="title2" style={{ marginTop: 20, marginBottom: 12 }}>{l(s.title)}</Txt>
            <View style={{ gap: 12 }}>
              {s.items.map((item, ii) => {
                const n = itemsInCart(item.id);
                return (
                  <Animated.View key={item.id} entering={rise(ii * 40)}>
                    <Tap onPress={() => router.push(`/item/${v.id}/${item.id}`)} scale={0.98}>
                      <View style={[styles.item, { backgroundColor: t.card }, shadow(t, 1)]}>
                        <View style={{ flex: 1, gap: 4 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Txt variant="headline" numberOfLines={2} style={{ flexShrink: 1 }}>{l(item.name)}</Txt>
                          </View>
                          {item.popular ? <Badge text={tr('popular')} icon="flame" tone="warning" /> : null}
                          <Txt variant="footnote" color="secondary" numberOfLines={2}>{l(item.desc)}</Txt>
                          <Txt variant="callout" style={{ fontWeight: '800', marginTop: 4 }}>{money(item.price, lang)}</Txt>
                        </View>
                        <View>
                          <Art emoji={item.emoji} size={92} radiusPx={radius.lg} />
                          <View style={styles.addWrap}>
                            <Tap
                              disabled={!open}
                              scale={0.85}
                              feedback={false}
                              onPress={() => {
                                haptic.medium();
                                if (needsOptions(item) || (item.groups?.length ?? 0) > 0) router.push(`/item/${v.id}/${item.id}`);
                                else addToCartSafe(v.id, { itemId: item.id, qty: 1, sel: {} });
                              }}
                            >
                              <View style={[styles.add, { backgroundColor: n ? t.primary : t.card, opacity: open ? 1 : 0.4 }, shadow(t, 2)]}>
                                {n ? <Text style={{ color: t.onPrimary, fontWeight: '800' }}>{n}</Text> : <Ionicons name="add" size={22} color={t.primaryText} />}
                              </View>
                            </Tap>
                          </View>
                        </View>
                      </View>
                    </Tap>
                  </Animated.View>
                );
              })}
            </View>
          </View>
        ))}
      </Animated.ScrollView>

      {/* floating nav */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { bottom: undefined, height: insets.top + 56 }, barStyle]}>
        <BlurView intensity={70} tint={t.isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View pointerEvents={stuck ? 'auto' : 'none'} style={[{ position: 'absolute', top: insets.top + 56, start: 0, end: 0, backgroundColor: t.bg }, stickStyle]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 8, paddingVertical: 8 }}>
          {v.menu.map((s, i) => <Chip key={s.id} label={l(s.title)} active={active === i} onPress={() => goSection(i)} />)}
        </ScrollView>
      </Animated.View>
      <View style={[styles.nav, { top: insets.top + 8 }]} pointerEvents="box-none">
        <GlassCircle onPress={() => router.back()}><BackGlyph /></GlassCircle>
        <Animated.View style={[{ flex: 1, alignItems: 'center' }, barStyle]} pointerEvents="none">
          <Txt variant="headline" numberOfLines={1}>{l(v.name)}</Txt>
        </Animated.View>
        <Heart id={v.id} />
      </View>

      <CartBar bottom={insets.bottom + 12} />
    </View>
  );
}

function Stat({ icon, label, value, good }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; good?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 2, paddingVertical: 4 }}>
      <Ionicons name={icon} size={18} color={good ? t.success : t.primary} />
      <Txt variant="footnote" style={{ fontWeight: '800', color: good ? t.success : t.text }}>{value}</Txt>
      <Txt variant="caption" color="tertiary">{label}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  infoCard: { marginHorizontal: 16, marginTop: -40, borderRadius: radius.xl, borderCurve: 'continuous', padding: 18 },
  stats: { flexDirection: 'row', marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  nav: { position: 'absolute', start: 16, end: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  item: { flexDirection: 'row', gap: 14, padding: 14, borderRadius: radius.lg, borderCurve: 'continuous' },
  addWrap: { position: 'absolute', end: -6, bottom: -6 },
  add: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
