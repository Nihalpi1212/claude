import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ComponentProps } from 'react';
import type { Tabs } from 'expo-router';
import { Tap, haptic } from './ui';
import { CartBar } from './CartBar';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { stageOf } from '@/lib/orders';
import { shadow, useTheme } from '@/theme';

const ICONS: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  index: ['home', 'home-outline'],
  search: ['search', 'search-outline'],
  orders: ['receipt', 'receipt-outline'],
  account: ['person', 'person-outline'],
};
const LABEL: Record<string, 'tabHome' | 'tabSearch' | 'tabOrders' | 'tabAccount'> = {
  index: 'tabHome', search: 'tabSearch', orders: 'tabOrders', account: 'tabAccount',
};

export const TAB_BAR_HEIGHT = 68;

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

function TabItem({ name, focused, onPress, badge }: { name: string; focused: boolean; onPress: () => void; badge?: number }) {
  const t = useTheme();
  const { t: tr } = useT();
  const pill = useAnimatedStyle(() => ({
    opacity: withSpring(focused ? 1 : 0, { damping: 20 }),
    transform: [{ scale: withSpring(focused ? 1 : 0.6, { damping: 14, stiffness: 240 }) }],
  }));
  const icon = useAnimatedStyle(() => ({ transform: [{ translateY: withSpring(focused ? -1 : 0) }, { scale: withSpring(focused ? 1.08 : 1, { damping: 12 }) }] }));
  const [on, off] = ICONS[name] ?? ICONS.index;
  return (
    <Tap onPress={onPress} scale={0.88} style={{ flex: 1 }} feedback={false}>
      <View style={styles.item}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.pill, { backgroundColor: t.primaryTint }, pill]} />
        <Animated.View style={icon}>
          <Ionicons name={focused ? on : off} size={23} color={focused ? t.primary : t.textSecondary} />
          {badge ? (
            <View style={[styles.badge, { backgroundColor: t.primary }]}>
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{badge}</Text>
            </View>
          ) : null}
        </Animated.View>
        <Text style={{ fontSize: 10.5, fontWeight: '700', marginTop: 2, color: focused ? t.primary : t.textSecondary }}>{tr(LABEL[name] ?? 'tabHome')}</Text>
      </View>
    </Tap>
  );
}

/** Floating glass tab bar with spring-animated selection. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const active = useStore((s) => s.orders.filter((o) => o.status === 'active' && stageOf(o) < 4).length);
  const bottom = Math.max(insets.bottom, 12) + 4;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <CartBar bottom={bottom + TAB_BAR_HEIGHT + 10} />
      <View style={[styles.shadowWrap, { bottom }, shadow(t, 3)]}>
      <View style={styles.wrap}>
        <BlurView
          intensity={Platform.OS === 'ios' ? 70 : 100}
          tint={t.isDark ? 'dark' : 'light'}
          style={[StyleSheet.absoluteFill, { backgroundColor: t.isDark ? 'rgba(28,28,31,0.72)' : 'rgba(255,255,255,0.78)' }]}
        />
        <View style={styles.inner}>
          {state.routes.map((route, i) => {
            const focused = state.index === i;
            return (
              <TabItem
                key={route.key}
                name={route.name}
                focused={focused}
                badge={route.name === 'orders' ? active : undefined}
                onPress={() => {
                  const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                  if (!focused && !e.defaultPrevented) {
                    haptic.select();
                    navigation.navigate(route.name as never);
                  }
                }}
              />
            );
          })}
        </View>
      </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shadowWrap: { position: 'absolute', start: 16, end: 16, height: TAB_BAR_HEIGHT, borderRadius: 34, borderCurve: 'continuous' },
  wrap: { flex: 1, borderRadius: 34, borderCurve: 'continuous', overflow: 'hidden' },
  inner: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  item: { height: 54, alignItems: 'center', justifyContent: 'center' },
  pill: { borderRadius: 27, borderCurve: 'continuous' },
  badge: { position: 'absolute', top: -5, end: -9, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
});
