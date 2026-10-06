import React from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, Row, Tap, Txt } from '@/components/ui';
import { TAB_BAR_HEIGHT } from '@/components/TabBar';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { formatPhone, money } from '@/lib/format';
import { brand, shadow, useTheme } from '@/theme';

export default function Account() {
  const t = useTheme();
  const { t: tr, lang } = useT();
  const insets = useSafeAreaInsets();
  const user = useStore((s) => s.user);
  const wallet = useStore((s) => s.wallet);
  const plus = useStore((s) => s.plus);
  const favs = useStore((s) => s.favorites.length);
  const addrs = useStore((s) => s.addresses.length);
  const signOut = useStore((s) => s.signOut);
  const name = user?.name ?? 'Guest';

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 20, paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 100, gap: 16 }} showsVerticalScrollIndicator={false}>
        <Txt variant="largeTitle">{tr('accountTitle')}</Txt>

        <Animated.View entering={FadeInDown.springify().damping(18)} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <LinearGradient colors={[brand.maroonLight, brand.maroon]} style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800' }}>{name.trim()[0]?.toUpperCase()}</Text>
          </LinearGradient>
          <View style={{ flex: 1 }}>
            <Txt variant="title2">{name}</Txt>
            <Txt variant="subhead" color="secondary">{user ? formatPhone(user.phone) : tr('guest')}</Txt>
          </View>
        </Animated.View>

        {/* Plus banner */}
        <Animated.View entering={FadeInDown.delay(60).springify().damping(18)}>
          <Tap onPress={() => router.push('/plus')} scale={0.98}>
            <LinearGradient colors={['#2A2A2E', '#0E0E10']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 24, borderCurve: 'continuous', padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: brand.goldDeep, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="star" size={24} color="#fff" /></View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: brand.gold, fontWeight: '800', fontSize: 17 }}>{tr('kaserPlus')}</Text>
                <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, marginTop: 2 }}>{plus ? tr('plusActive') : tr('plusSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.5)" />
            </LinearGradient>
          </Tap>
        </Animated.View>

        {/* Wallet */}
        <Animated.View entering={FadeInDown.delay(110).springify().damping(18)}>
          <Card onPress={() => router.push('/wallet')} style={{ padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: t.primaryTint, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="wallet" size={24} color={t.primary} /></View>
            <View style={{ flex: 1 }}>
              <Txt variant="footnote" color="secondary">{tr('walletTitle')}</Txt>
              <Txt variant="title2">{money(wallet, lang, true)}</Txt>
            </View>
            <View style={{ paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontWeight: '700' }}>{tr('topUp')}</Text></View>
          </Card>
        </Animated.View>

        <Card delay={150}>
          <Row icon="location" title={tr('addresses')} value={String(addrs)} onPress={() => router.push('/addresses')} />
          <Row icon="heart" tint="#E5484D" title={tr('favorites')} value={String(favs)} onPress={() => router.push('/favorites')} />
          <Row icon="pricetags" tint="#F2A100" title={tr('offers')} onPress={() => router.push('/promos')} last />
        </Card>

        <Card delay={190}>
          <Row icon="language" tint="#5B9BE6" title={tr('language')} value={lang === 'ar' ? 'العربية' : 'English'} onPress={() => router.push('/language')} />
          <Row icon="help-buoy" tint="#2BB5A6" title={tr('helpCenter')} onPress={() => router.push('/help')} />
          <Row icon="information-circle" tint="#8E8E93" title={tr('about')} value={`${tr('version')} ${Constants.expoConfig?.version ?? '1.0.0'}`} last />
        </Card>

        <Card delay={230}>
          <Row icon="log-out" tint={t.danger} title={tr('signOut')} destructive last onPress={() => Alert.alert(tr('signOut'), undefined, [{ text: tr('cancel'), style: 'cancel' }, { text: tr('signOut'), style: 'destructive', onPress: () => signOut() }])} />
        </Card>
      </ScrollView>
    </View>
  );
}
