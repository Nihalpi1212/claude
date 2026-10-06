import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackGlyph, GlassCircle, Txt } from './ui';
import { useTheme } from '@/theme';

/** Compact header with a round back/close button. */
export function Header({ title, right, close, onBack, noTop }: { title?: string; right?: React.ReactNode; close?: boolean; onBack?: () => void; noTop?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const back = () => (onBack ? onBack() : router.canGoBack() ? router.back() : router.replace('/(tabs)'));
  return (
    <View style={{ paddingTop: noTop ? 8 : insets.top + 6, paddingBottom: 10, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.bg }}>
      <GlassCircle onPress={back}>{close ? <Ionicons name="close" size={22} color={t.text} /> : <BackGlyph />}</GlassCircle>
      <Txt variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: 'center' }}>{title}</Txt>
      <View style={{ minWidth: 40, alignItems: 'flex-end' }}>{right ?? <View style={{ width: 40 }} />}</View>
    </View>
  );
}
