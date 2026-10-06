import React from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Empty } from '@/components/ui';
import { Header } from '@/components/Header';
import { VendorCard } from '@/components/VendorCard';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { vendors } from '@/data/vendors';
import { useTheme } from '@/theme';

export default function Favorites() {
  const t = useTheme();
  const { t: tr } = useT();
  const insets = useSafeAreaInsets();
  const favs = useStore((s) => s.favorites);
  const list = vendors.filter((v) => favs.includes(v.id));
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header title={tr('favorites')} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        {list.length === 0 ? <Empty emoji="💔" title={tr('favEmpty')} body={tr('favEmptyBody')} action={tr('browse')} onAction={() => router.back()} /> : list.map((v, i) => <VendorCard key={v.id} v={v} delay={i * 40} compact />)}
      </ScrollView>
    </View>
  );
}
