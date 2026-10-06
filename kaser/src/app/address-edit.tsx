import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Chip, Txt } from '@/components/ui';
import { Header } from '@/components/Header';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { areas } from '@/data/catalog';
import type { Address } from '@/data/types';
import { radius, useTheme } from '@/theme';

export default function AddressEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const t = useTheme();
  const { t: tr, l } = useT();
  const insets = useSafeAreaInsets();
  const existing = useStore((s) => s.addresses.find((a) => a.id === id));
  const save = useStore((s) => s.saveAddress);
  const select = useStore((s) => s.selectAddress);
  const [a, setA] = useState<Omit<Address, 'id'>>(existing ?? { label: 'home', area: 'westbay', zone: '', street: '', building: '', unit: '', landmark: '' });
  const set = (k: keyof typeof a, v: string) => setA((x) => ({ ...x, [k]: v }));
  const ok = a.zone.trim() && a.street.trim() && a.building.trim();

  const field = (k: keyof typeof a, label: string, kb?: 'number-pad') => (
    <View style={{ flex: 1, gap: 6 }}>
      <Txt variant="footnote" color="secondary" style={{ fontWeight: '600' }}>{label}</Txt>
      <TextInput value={a[k] as string} onChangeText={(v) => set(k, v)} keyboardType={kb} placeholderTextColor={t.textTertiary} style={[styles.input, { backgroundColor: t.card, color: t.text }]} />
    </View>
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <Header close noTop title={existing ? tr('editAddress') : tr('addAddress')} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 140 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={{ gap: 8 }}>
          <Txt variant="footnote" color="secondary" style={{ fontWeight: '600' }}>{tr('label')}</Txt>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['home', 'work', 'other'] as const).map((k) => <Chip key={k} label={tr(k)} active={a.label === k} onPress={() => set('label', k)} />)}
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <Txt variant="footnote" color="secondary" style={{ fontWeight: '600' }}>{tr('area')}</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {areas.map((x) => <Chip key={x.id} label={l(x.name)} active={a.area === x.id} onPress={() => set('area', x.id)} />)}
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {field('zone', tr('zone'), 'number-pad')}
          {field('street', tr('street'), 'number-pad')}
          {field('building', tr('building'), 'number-pad')}
        </View>
        {field('unit', tr('unit'))}
        {field('landmark', tr('landmark'))}
      </ScrollView>
      <View style={{ position: 'absolute', bottom: 0, start: 0, end: 0, padding: 20, paddingBottom: insets.bottom + 12, backgroundColor: t.bg }}>
        <Button title={tr('saveAddress')} disabled={!ok} onPress={() => { const nid = save({ ...a, id: existing?.id }); select(nid); router.back(); }} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ input: { height: 50, borderRadius: radius.md, borderCurve: 'continuous', paddingHorizontal: 14, fontSize: 16, fontWeight: '600' } });
