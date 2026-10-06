import { rise } from '@/lib/motion';
import React, { useMemo, useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Art, Card, Chip, Empty, SectionHeader, Tap, Txt } from '@/components/ui';
import { VendorCard } from '@/components/VendorCard';
import { TAB_BAR_HEIGHT } from '@/components/TabBar';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { categories, popularSearches } from '@/data/catalog';
import { searchAll } from '@/lib/search';
import { money } from '@/lib/format';
import { radius, shadow, useTheme } from '@/theme';

export default function Search() {
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const insets = useSafeAreaInsets();
  const recent = useStore((s) => s.recent);
  const addRecent = useStore((s) => s.addRecent);
  const clearRecent = useStore((s) => s.clearRecent);
  const [q, setQ] = useState('');
  const res = useMemo(() => searchAll(q, lang), [q, lang]);
  const empty = q.trim().length > 0 && res.stores.length === 0 && res.dishes.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 100 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20, gap: 14 }}>
          <Txt variant="largeTitle">{tr('tabSearch')}</Txt>
          <View style={[styles.search, { backgroundColor: t.card }, shadow(t, 1)]}>
            <Ionicons name="search" size={20} color={t.textSecondary} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={tr('searchPlaceholder')}
              placeholderTextColor={t.textTertiary}
              returnKeyType="search"
              onSubmitEditing={() => q.trim() && addRecent(q.trim())}
              style={{ flex: 1, fontSize: 17, color: t.text, height: 54 }}
            />
            {q ? <Tap onPress={() => setQ('')} scale={0.8}><Ionicons name="close-circle" size={20} color={t.textTertiary} /></Tap> : null}
          </View>
        </View>

        {q.trim() === '' ? (
          <Animated.View entering={FadeIn}>
            {recent.length > 0 && (
              <>
                <SectionHeader title={tr('recent')} action={tr('clear')} onAction={clearRecent} />
                <View style={styles.wrap}>{recent.map((r) => <Chip key={r} icon="time-outline" label={r} onPress={() => setQ(r)} />)}</View>
              </>
            )}
            <SectionHeader title={tr('popularSearches')} />
            <View style={styles.wrap}>{popularSearches.map((r) => <Chip key={r} icon="trending-up" label={r} onPress={() => setQ(r)} />)}</View>
            <SectionHeader title={tr('categories')} />
            <View style={[styles.wrap, { gap: 12 }]}>
              {categories.map((c, i) => (
                <Animated.View key={c.id} entering={rise(i * 25)} style={{ width: '48%' }}>
                  <Tap onPress={() => router.push(`/category/${c.id}`)} scale={0.95}>
                    <Art emoji={c.emoji} colors={c.colors} radiusPx={20} style={{ height: 84, alignItems: 'flex-start', justifyContent: 'flex-end', padding: 12 }} />
                    <View style={{ position: 'absolute', start: 14, bottom: 12 }}><Txt variant="callout" style={{ fontWeight: '800' }}>{l(c.name)}</Txt></View>
                  </Tap>
                </Animated.View>
              ))}
            </View>
          </Animated.View>
        ) : empty ? (
          <Empty emoji="🔍" title={tr('noResults')} body={tr('noResultsBody')} />
        ) : (
          <Animated.View entering={FadeIn}>
            {res.dishes.length > 0 && (
              <>
                <SectionHeader title={tr('dishes')} />
                <View style={{ paddingHorizontal: 20, gap: 10 }}>
                  {res.dishes.map(({ vendor, item }) => (
                    <Card key={vendor.id + item.id} onPress={() => { addRecent(q.trim()); Keyboard.dismiss(); router.push(`/item/${vendor.id}/${item.id}`); }} style={{ padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <Art emoji={item.emoji} colors={vendor.colors} size={56} radiusPx={16} />
                      <View style={{ flex: 1 }}>
                        <Txt variant="callout" style={{ fontWeight: '700' }} numberOfLines={1}>{l(item.name)}</Txt>
                        <Txt variant="footnote" color="secondary" numberOfLines={1}>{l(vendor.name)}</Txt>
                      </View>
                      <Txt variant="callout" style={{ fontWeight: '800' }}>{money(item.price, lang)}</Txt>
                    </Card>
                  ))}
                </View>
              </>
            )}
            {res.stores.length > 0 && (
              <>
                <SectionHeader title={tr('storesSection')} />
                <View style={{ paddingHorizontal: 20, gap: 16 }}>{res.stores.map((v, i) => <VendorCard key={v.id} v={v} compact delay={i * 40} />)}</View>
              </>
            )}
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, borderRadius: 20, borderCurve: 'continuous' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20 },
});
