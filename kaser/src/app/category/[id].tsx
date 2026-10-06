import React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Empty } from '@/components/ui';
import { Header } from '@/components/Header';
import { VendorCard } from '@/components/VendorCard';
import { CartBar } from '@/components/CartBar';
import { useT } from '@/i18n';
import { categories } from '@/data/catalog';
import { vendors } from '@/data/vendors';
import { sortVendors } from '@/lib/search';
import { useTheme } from '@/theme';

export default function Category() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { t: tr, l } = useT();
  const insets = useSafeAreaInsets();
  const c = categories.find((x) => x.id === id);
  const list = sortVendors(vendors.filter((v) => v.categoryId === id), 'recommended');
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header title={c ? `${c.emoji} ${l(c.name)}` : ''} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: insets.bottom + 120 }} showsVerticalScrollIndicator={false}>
        {list.length === 0 ? <Empty emoji="🔍" title={tr('noResults')} body={tr('noResultsBody')} /> : list.map((v, i) => <VendorCard key={v.id} v={v} delay={i * 50} />)}
      </ScrollView>
      <CartBar bottom={insets.bottom + 12} />
    </View>
  );
}
