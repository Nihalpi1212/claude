import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { Stack, SplashScreen } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ReduceMotion, ReducedMotionConfig } from 'react-native-reanimated';
import { useStore } from '@/store';
import { useT } from '@/i18n';
import { applyDirection } from '@/lib/rtl';
import { useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const t = useTheme();
  const { t: tr, lang } = useT();
  const hydrated = useStore((s) => s.hydrated);
  const tick = useStore((s) => s.tick);
  const onboarded = useStore((s) => s.onboarded);
  const authed = useStore((s) => !!s.user || s.guest);

  useEffect(() => {
    // Zustand hydrates from AsyncStorage asynchronously
    if (useStore.persist.hasHydrated()) useStore.setState({ hydrated: true });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    applyDirection(lang);
    SplashScreen.hideAsync().catch(() => {});
  }, [hydrated, lang]);

  // advance the (simulated) order lifecycle
  useEffect(() => {
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [tick]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.bg }}>
      <SafeAreaProvider>
        <ReducedMotionConfig mode={ReduceMotion.System} />
        <StatusBar style={t.isDark ? 'light' : 'dark'} />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg }, animation: 'slide_from_right' }}>
          <Stack.Protected guard={!onboarded}>
            <Stack.Screen name="onboarding" options={{ animation: 'fade', gestureEnabled: false }} />
          </Stack.Protected>
          <Stack.Protected guard={onboarded && !authed}>
            <Stack.Screen name="login" options={{ animation: 'fade', gestureEnabled: false }} />
          </Stack.Protected>
          <Stack.Protected guard={onboarded && authed}>
            <Stack.Screen name="(tabs)" options={{ animation: 'fade', gestureEnabled: false }} />
            <Stack.Screen name="restaurant/[id]" />
            <Stack.Screen name="item/[vendorId]/[itemId]" options={{ presentation: 'modal', animation: 'slide_from_bottom', gestureEnabled: true }} />
            <Stack.Screen name="cart" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="checkout" />
            <Stack.Screen name="tracking/[id]" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="category/[id]" />
            <Stack.Screen name="addresses" />
            <Stack.Screen name="address-edit" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="wallet" />
            <Stack.Screen name="plus" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="favorites" />
            <Stack.Screen name="promos" />
            <Stack.Screen name="language" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="help" />
            <Stack.Screen name="order/[id]" />
          </Stack.Protected>
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
