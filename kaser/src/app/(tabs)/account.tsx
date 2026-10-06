import { rise } from '@/lib/motion';
import React from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, Row, Tap, Txt } from '@/components/ui';
import { TAB_BAR_HEIGHT } from '@/components/TabBar';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { formatPhone, money } from '@/lib/format';
import { brand, radius, useTheme } from '@/theme';

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

        <Animated.View entering={rise()} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: t.onPrimary, fontSize: 26, fontWeight: '800' }}>{name.trim()[0]?.toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Txt variant="title2">{name}</Txt>
            <Txt variant="subhead" color="secondary">{user ? formatPhone(user.phone) : tr('guest')}</Txt>
          </View>
        </Animated.View>

        {/* Plus banner */}
        <Animated.View entering={rise(60)}>
          <Tap onPress={() => router.push('/plus')} scale={0.98}>
            <View style={{ backgroundColor: brand.ink, borderRadius: radius.lg, borderCurve: 'continuous', padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: brand.orange, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="star" size={24} color={brand.ink} /></View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: brand.cream, fontWeight: '800', fontSize: 17 }}>{tr('kaserPlus')}</Text>
                <Text style={{ color: 'rgba(255,248,238,0.75)', fontSize: 13, marginTop: 2 }}>{plus ? tr('plusActive') : tr('plusSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="rgba(255,248,238,0.5)" />
            </View>
          </Tap>
        </Animated.View>

        {/* Wallet */}
        <Animated.View entering={rise(110)}>
          <Card onPress={() => router.push('/wallet')} style={{ padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: t.primaryTint, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="wallet" size={24} color={t.primaryText} /></View>
            <View style={{ flex: 1 }}>
              <Txt variant="footnote" color="secondary">{tr('walletTitle')}</Txt>
              <Txt variant="title2">{money(wallet, lang, true)}</Txt>
            </View>
            <View style={{ paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.onPrimary, fontWeight: '800' }}>{tr('topUp')}</Text></View>
          </Card>
        </Animated.View>

        <Card delay={150}>
          <Row icon="location" title={tr('addresses')} value={String(addrs)} onPress={() => router.push('/addresses')} />
          <Row icon="heart" tint={t.danger} title={tr('favorites')} value={String(favs)} onPress={() => router.push('/favorites')} />
          <Row icon="pricetags" tint={t.primary} title={tr('offers')} onPress={() => router.push('/promos')} last />
        </Card>

        <Card delay={190}>
          <Row icon="language" tint={t.text} title={tr('language')} value={lang === 'ar' ? 'العربية' : 'English'} onPress={() => router.push('/language')} />
          <Row icon="help-buoy" tint={t.success} title={tr('helpCenter')} onPress={() => router.push('/help')} />
          <Row icon="information-circle" tint={t.textSecondary} title={tr('about')} value={`${tr('version')} ${Constants.expoConfig?.version ?? '1.0.0'}`} last />
        </Card>

        <Card delay={230}>
          <Row icon="log-out" tint={t.danger} title={tr('signOut')} destructive last onPress={() => Alert.alert(tr('signOut'), undefined, [{ text: tr('cancel'), style: 'cancel' }, { text: tr('signOut'), style: 'destructive', onPress: () => signOut() }])} />
        </Card>
      </ScrollView>
    </View>
  );
}
