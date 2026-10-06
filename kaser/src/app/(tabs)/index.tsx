import React, { useEffect, useMemo, useState } from 'react';
import { Dimensions, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeInRight, Extrapolation, interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Art, Chip, Chevron, GlassCircle, SectionHeader, Tap, Txt, haptic } from '@/components/ui';
import { VendorCard } from '@/components/VendorCard';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { areas, categories, promos } from '@/data/catalog';
import { isOpen, vendors, vendorById } from '@/data/vendors';
import { sortVendors, type SortKey } from '@/lib/search';
import { TAB_BAR_HEIGHT } from '@/components/TabBar';
import { brand, radius, shadow, useTheme } from '@/theme';

const W = Dimensions.get('window').width;
const PROMO_W = W - 56;

export default function Home() {
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const insets = useSafeAreaInsets();
  const user = useStore((s) => s.user);
  const addresses = useStore((s) => s.addresses);
  const selectedId = useStore((s) => s.selectedAddressId);
  const saveAddress = useStore((s) => s.saveAddress);
  const orders = useStore((s) => s.orders);
  const plus = useStore((s) => s.plus);
  const [sort, setSort] = useState<SortKey>('recommended');
  const [fOffers, setFOffers] = useState(false);
  const [fFree, setFFree] = useState(false);
  const [fOpen, setFOpen] = useState(false);

  // first launch: seed a sensible default address so the app is immediately usable
  useEffect(() => {
    if (addresses.length === 0) saveAddress({ label: 'home', area: 'westbay', zone: '61', street: '850', building: '12', unit: '', landmark: '' });
  }, []);

  const address = addresses.find((a) => a.id === selectedId) ?? addresses[0];
  const areaName = address ? l(areas.find((x) => x.id === address.area)?.name ?? { en: '', ar: '' }) : tr('noAddress');

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => { scrollY.value = e.contentOffset.y; });
  const barStyle = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [20, 90], [0, 1], Extrapolation.CLAMP) }));

  const list = useMemo(() => {
    let v = vendors;
    if (fOffers) v = v.filter((x) => !!x.promo);
    if (fFree) v = v.filter((x) => x.deliveryFee === 0);
    if (fOpen) v = v.filter((x) => isOpen(x));
    return sortVendors(v, sort);
  }, [sort, fOffers, fFree, fOpen]);

  const again = orders.filter((o) => o.status === 'delivered').slice(0, 6);
  const top = sortVendors(vendors, 'rating').slice(0, 6);
  const fast = sortVendors(vendors, 'fastest').slice(0, 6);
  const hello = user?.name ? user.name.split(' ')[0] : '';

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 120 }} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Tap onPress={() => router.push('/addresses')} scale={0.96} style={{ flex: 1 }}>
            <View>
              <Txt variant="caption" color="secondary" style={{ textTransform: 'uppercase', letterSpacing: 0.8 }}>{tr('deliverTo')}</Txt>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <Ionicons name="location" size={18} color={t.primary} />
                <Txt variant="title3" numberOfLines={1} style={{ flexShrink: 1 }}>{areaName}</Txt>
                <Ionicons name="chevron-down" size={16} color={t.textSecondary} />
              </View>
            </View>
          </Tap>
          {plus ? (
            <Tap onPress={() => router.push('/plus')}><View style={styles.plusPill}><Ionicons name="star" size={12} color="#fff" /><Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>PLUS</Text></View></Tap>
          ) : null}
          <GlassCircle onPress={() => router.push('/promos')}><Ionicons name="pricetags-outline" size={20} color={t.text} /></GlassCircle>
        </View>

        <Animated.View entering={FadeInDown.springify().damping(18)} style={{ paddingHorizontal: 20, marginTop: 6 }}>
          <Txt variant="largeTitle" numberOfLines={1} adjustsFontSizeToFit>{hello ? (lang === 'ar' ? `أهلاً ${hello} 👋` : `Hello, ${hello} 👋`) : (lang === 'ar' ? 'جائع؟ 👋' : 'Hungry? 👋')}</Txt>
        </Animated.View>

        {/* Search */}
        <Animated.View entering={FadeInDown.delay(60).springify().damping(18)} style={{ paddingHorizontal: 20, marginTop: 14 }}>
          <Tap onPress={() => router.navigate('/(tabs)/search')} scale={0.985}>
            <View style={[styles.search, { backgroundColor: t.card }, shadow(t, 1)]}>
              <Ionicons name="search" size={20} color={t.textSecondary} />
              <Txt variant="callout" color="tertiary" numberOfLines={1} style={{ flex: 1 }}>{tr('searchPlaceholder')}</Txt>
            </View>
          </Tap>
        </Animated.View>

        {/* Categories */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 12, paddingVertical: 20 }}>
          {categories.map((c, i) => (
            <Animated.View key={c.id} entering={FadeInRight.delay(80 + i * 30).springify().damping(16)}>
              <Tap onPress={() => router.push(`/category/${c.id}`)} scale={0.92}>
                <View style={{ alignItems: 'center', width: 76, gap: 8 }}>
                  <Art emoji={c.emoji} colors={c.colors} size={68} radiusPx={22} />
                  <Txt variant="caption" numberOfLines={1} style={{ fontWeight: '600' }}>{l(c.name)}</Txt>
                </View>
              </Tap>
            </Animated.View>
          ))}
        </ScrollView>

        {/* Promos */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={PROMO_W + 12} decelerationRate="fast" contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}>
          {promos.map((p, i) => (
            <Animated.View key={p.code} entering={FadeInRight.delay(120 + i * 60).springify().damping(16)}>
              <Tap onPress={() => router.push('/promos')} scale={0.97}>
                <LinearGradient colors={p.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.promo, { width: PROMO_W }]}>
                  <View style={{ flex: 1, gap: 6 }}>
                    <Txt variant="title3" style={{ color: '#fff' }} numberOfLines={2}>{l(p.title)}</Txt>
                    <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13 }}>{l(p.desc)}</Text>
                    <View style={styles.codePill}><Text style={{ color: '#fff', fontWeight: '800', letterSpacing: 1.2, fontSize: 12 }}>{p.code}</Text></View>
                  </View>
                  <Text style={{ fontSize: 64 }}>{p.emoji}</Text>
                </LinearGradient>
              </Tap>
            </Animated.View>
          ))}
        </ScrollView>

        {/* Order again */}
        {again.length > 0 && (
          <>
            <SectionHeader title={tr('orderAgain')} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 14 }}>
              {[...new Set(again.map((o) => o.vendorId))].map((id) => {
                const v = vendorById(id)!;
                return (
                  <Tap key={id} onPress={() => router.push(`/restaurant/${id}`)} scale={0.94}>
                    <View style={{ alignItems: 'center', width: 84, gap: 6 }}>
                      <Art emoji={v.emoji} colors={v.colors} size={72} radiusPx={36} />
                      <Txt variant="caption" numberOfLines={1} style={{ fontWeight: '600' }}>{l(v.name)}</Txt>
                    </View>
                  </Tap>
                );
              })}
            </ScrollView>
          </>
        )}

        {/* Top rated */}
        <SectionHeader title={tr('topRated')} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 14, paddingBottom: 6 }}>
          {top.map((v, i) => <VendorCard key={v.id} v={v} width={280} compact delay={i * 50} />)}
        </ScrollView>

        {/* Fastest */}
        <SectionHeader title={tr('fastest')} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 14, paddingBottom: 6 }}>
          {fast.map((v, i) => <VendorCard key={v.id} v={v} width={280} compact delay={i * 50} />)}
        </ScrollView>

        {/* All stores */}
        <SectionHeader title={tr('allStores')} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 8, paddingBottom: 14 }}>
          <Chip icon="options-outline" label={sort === 'recommended' ? tr('sortRecommended') : sort === 'rating' ? tr('sortRating') : sort === 'fastest' ? tr('sortFastest') : tr('sortDelivery')} active={sort !== 'recommended'} onPress={() => setSort(sort === 'recommended' ? 'rating' : sort === 'rating' ? 'fastest' : sort === 'fastest' ? 'delivery' : 'recommended')} />
          <Chip icon="pricetag-outline" label={tr('filterOffers')} active={fOffers} onPress={() => setFOffers(!fOffers)} />
          <Chip icon="bicycle" label={tr('filterFree')} active={fFree} onPress={() => setFFree(!fFree)} />
          <Chip icon="time-outline" label={tr('filterOpen')} active={fOpen} onPress={() => setFOpen(!fOpen)} />
        </ScrollView>
        <View style={{ paddingHorizontal: 20, gap: 16 }}>
          {list.map((v, i) => <VendorCard key={v.id} v={v} delay={Math.min(i, 4) * 40} />)}
        </View>
      </Animated.ScrollView>

      {/* collapsing glass status bar */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { bottom: undefined, height: insets.top + 44 }, barStyle]}>
        <BlurView intensity={60} tint={t.isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill}>
          <View style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 10 }}>
            <Txt variant="headline">{areaName}</Txt>
          </View>
        </BlurView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 54, paddingHorizontal: 16, borderRadius: 20, borderCurve: 'continuous' },
  promo: { height: 142, borderRadius: radius.xl, borderCurve: 'continuous', padding: 20, flexDirection: 'row', alignItems: 'center' },
  codePill: { alignSelf: 'flex-start', paddingHorizontal: 10, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  plusPill: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: brand.goldDeep },
});
