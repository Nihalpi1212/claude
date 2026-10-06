import React from 'react';
import { Alert, ScrollView, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Empty, Tap, Txt, haptic } from '@/components/ui';
import { Header } from '@/components/Header';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { areas } from '@/data/catalog';
import { useTheme } from '@/theme';

const ICON = { home: 'home', work: 'briefcase', other: 'location' } as const;

export default function Addresses() {
  const t = useTheme();
  const { t: tr, l } = useT();
  const insets = useSafeAreaInsets();
  const list = useStore((s) => s.addresses);
  const sel = useStore((s) => s.selectedAddressId);
  const select = useStore((s) => s.selectAddress);
  const del = useStore((s) => s.deleteAddress);
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header title={tr('addresses')} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: insets.bottom + 120 }} showsVerticalScrollIndicator={false}>
        {list.length === 0 ? <Empty emoji="📍" title={tr('noAddress')} body="" /> : null}
        {list.map((a, i) => {
          const on = (sel ?? list[0]?.id) === a.id;
          return (
            <Animated.View key={a.id} entering={FadeInDown.delay(i * 40).springify().damping(18)} exiting={FadeOut} layout={LinearTransition.springify()}>
              <Card onPress={() => { haptic.select(); select(a.id); router.back(); }} style={{ padding: 16, borderWidth: on ? 2 : 0, borderColor: t.primary }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: t.primaryTint, alignItems: 'center', justifyContent: 'center' }}><Ionicons name={ICON[a.label]} size={20} color={t.primary} /></View>
                  <View style={{ flex: 1 }}>
                    <Txt variant="headline">{tr(a.label)} · {l(areas.find((x) => x.id === a.area)!.name)}</Txt>
                    <Txt variant="footnote" color="secondary" numberOfLines={2}>{tr('building')} {a.building}, {tr('street')} {a.street}, {tr('zone')} {a.zone}{a.unit ? `, ${a.unit}` : ''}{a.landmark ? ` · ${a.landmark}` : ''}</Txt>
                  </View>
                  {on ? <Ionicons name="checkmark-circle" size={24} color={t.primary} /> : null}
                </View>
                <View style={{ flexDirection: 'row', gap: 20, marginTop: 12, paddingStart: 54 }}>
                  <Tap onPress={() => router.push(`/address-edit?id=${a.id}`)}><Txt variant="subhead" color="primary" style={{ fontWeight: '600' }}>{tr('editAddress')}</Txt></Tap>
                  <Tap onPress={() => Alert.alert(tr('delete'), undefined, [{ text: tr('cancel'), style: 'cancel' }, { text: tr('delete'), style: 'destructive', onPress: () => del(a.id) }])}><Txt variant="subhead" color="danger" style={{ fontWeight: '600' }}>{tr('delete')}</Txt></Tap>
                </View>
              </Card>
            </Animated.View>
          );
        })}
      </ScrollView>
      <View style={{ position: 'absolute', bottom: 0, start: 0, end: 0, padding: 20, paddingBottom: insets.bottom + 12, backgroundColor: t.bg }}>
        <Button title={tr('addAddress')} icon="add" onPress={() => router.push('/address-edit')} />
      </View>
    </View>
  );
}
