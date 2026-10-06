import React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { Txt } from './ui';
import { useT, type Key } from '@/i18n';
import { useTheme } from '@/theme';

const STEPS: { k: Key; icon: keyof typeof Ionicons.glyphMap }[] = [
  { k: 'st_placed', icon: 'receipt' },
  { k: 'st_preparing', icon: 'restaurant' },
  { k: 'st_pickup', icon: 'bag-check' },
  { k: 'st_onway', icon: 'bicycle' },
  { k: 'st_delivered', icon: 'checkmark-done' },
];

function Node({ done, current, icon }: { done: boolean; current: boolean; icon: keyof typeof Ionicons.glyphMap }) {
  const t = useTheme();
  const a = useAnimatedStyle(() => ({ transform: [{ scale: withSpring(current ? 1.15 : 1, { damping: 10 }) }] }));
  return (
    <Animated.View style={[styles.node, { backgroundColor: done || current ? t.primary : t.fill }, a]}>
      <Ionicons name={done ? 'checkmark' : icon} size={14} color={done || current ? '#fff' : t.textTertiary} />
    </Animated.View>
  );
}

function Bar({ filled }: { filled: boolean }) {
  const t = useTheme();
  const a = useAnimatedStyle(() => ({ width: withSpring(filled ? '100%' : '0%', { damping: 20 }) }));
  return (
    <View style={[styles.bar, { backgroundColor: t.fill }]}>
      <Animated.View style={[{ height: '100%', backgroundColor: t.primary, borderRadius: 2 }, a]} />
    </View>
  );
}

/** Horizontal 5-step progress. */
export function Steps({ stage }: { stage: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {STEPS.map((s, i) => (
        <React.Fragment key={s.k}>
          <Node done={i < stage || stage === 4} current={i === stage && stage < 4} icon={s.icon} />
          {i < STEPS.length - 1 ? <Bar filled={i < stage} /> : null}
        </React.Fragment>
      ))}
    </View>
  );
}

export function useStatusText(stage: number, courierName: string) {
  const { t } = useT();
  const keys = ['st_placed', 'st_preparing', 'st_pickup', 'st_onway', 'st_delivered'] as const;
  const dkeys = ['st_placed_d', 'st_preparing_d', 'st_pickup_d', 'st_onway_d', 'st_delivered_d'] as const;
  return { title: t(keys[stage]), desc: t(dkeys[stage], { name: courierName }) };
}

const styles = StyleSheet.create({
  node: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  bar: { flex: 1, height: 4, borderRadius: 2, marginHorizontal: 3, overflow: 'hidden' },
});
