import React, { useEffect, useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Tap, Txt, haptic } from '@/components/ui';
import { KaserLogo, RingPattern } from '@/components/Brand';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { brand, radius, useTheme } from '@/theme';

const W = Dimensions.get('window').width;
const SLIDES = [
  { hero: '🍛', orbit: ['🥗', '🍔', '☕', '🍕'], t: 'ob1Title', b: 'ob1Body' },
  { hero: '🛵', orbit: ['📍', '🧾', '🕐', '🌯'], t: 'ob2Title', b: 'ob2Body' },
  { hero: '🎁', orbit: ['💳', '⭐', '🧡', '🛍️'], t: 'ob3Title', b: 'ob3Body' },
] as const;

function Float({ children, delay = 0, amp = 6, style }: { children: React.ReactNode; delay?: number; amp?: number; style?: any }) {
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withRepeat(withSequence(withTiming(-amp, { duration: 1800 + delay, easing: Easing.inOut(Easing.sin) }), withTiming(amp, { duration: 1800 + delay, easing: Easing.inOut(Easing.sin) })), -1, true);
  }, []);
  const a = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  return <Animated.View style={[a, style]}>{children}</Animated.View>;
}

function Dot({ active }: { active: boolean }) {
  const t = useTheme();
  const a = useAnimatedStyle(() => ({ width: withTiming(active ? 28 : 8, { duration: 200 }) }));
  return <Animated.View style={[{ height: 8, borderRadius: 4, backgroundColor: active ? t.primary : t.separator }, a]} />;
}

export default function Onboarding() {
  const t = useTheme();
  const { t: tr, lang, isRTL } = useT();
  const insets = useSafeAreaInsets();
  const setLang = useStore((s) => s.setLang);
  const finish = useStore((s) => s.finishOnboarding);
  const [i, setI] = useState(0);
  const last = i === SLIDES.length - 1;

  const go = (n: number) => {
    if (n < 0 || n >= SLIDES.length) return;
    haptic.select();
    setI(n);
  };
  const done = () => {
    haptic.success();
    finish();
  };
  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-20, 20])
    .onEnd((e) => {
      const next = isRTL ? e.translationX > 50 : e.translationX < -50;
      const prev = isRTL ? e.translationX < -50 : e.translationX > 50;
      if (next) go(i + 1);
      else if (prev) go(i - 1);
    });

  const s = SLIDES[i];
  const panelW = W - 40;
  const panelH = 300;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Tap onPress={() => setLang(lang === 'en' ? 'ar' : 'en')} scale={0.95}>
          <View style={[styles.langPill, { backgroundColor: t.fill }]}>
            <Text style={{ color: t.text, fontWeight: '700' }}>{lang === 'en' ? 'العربية' : 'English'}</Text>
          </View>
        </Tap>
        <KaserLogo size={48} />
        {!last ? (
          <Tap onPress={done} scale={0.95}>
            <Text style={{ color: t.textSecondary, fontWeight: '700', fontSize: 16, padding: 8 }}>{tr('skip')}</Text>
          </Tap>
        ) : <View style={{ width: 56 }} />}
      </View>

      <GestureDetector gesture={pan}>
        <View style={{ flex: 1, paddingHorizontal: 20 }}>
          <Animated.View key={i} entering={FadeIn.duration(240)} exiting={FadeOut.duration(120)} style={{ flex: 1, justifyContent: 'center' }}>
            {/* orange brand panel */}
            <View style={[styles.panel, { height: panelH, backgroundColor: t.primary }]}>
              <RingPattern width={panelW} height={panelH} opacity={0.16} />
              <Float amp={6}>
                <View style={styles.heroCircle}><Text style={{ fontSize: 88 }}>{s.hero}</Text></View>
              </Float>
              {s.orbit.map((e, k) => {
                const pos = [{ top: 18, start: 18 }, { top: 40, end: 14 }, { bottom: 28, start: 12 }, { bottom: 16, end: 28 }][k];
                return (
                  <Float key={k} delay={k * 250} amp={5 + k} style={[{ position: 'absolute' }, pos]}>
                    <View style={styles.orbitBubble}><Text style={{ fontSize: 26 }}>{e}</Text></View>
                  </Float>
                );
              })}
            </View>
            <Text style={[styles.title, { color: t.text }]}>{tr(s.t)}</Text>
            <Text style={[styles.body, { color: t.textSecondary }]}>{tr(s.b)}</Text>
          </Animated.View>
        </View>
      </GestureDetector>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 20 }]}>
        <View style={{ flexDirection: 'row', gap: 6, alignSelf: 'center', marginBottom: 20 }}>
          {SLIDES.map((_, k) => <Dot key={k} active={k === i} />)}
        </View>
        <Button title={last ? tr('getStarted') : tr('next')} onPress={() => (last ? done() : go(i + 1))} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20 },
  langPill: { paddingHorizontal: 14, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', minWidth: 56 },
  panel: { borderRadius: radius.xl, borderCurve: 'continuous', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', marginBottom: 28 },
  heroCircle: { width: 156, height: 156, borderRadius: 78, backgroundColor: brand.white, alignItems: 'center', justifyContent: 'center' },
  orbitBubble: { width: 54, height: 54, borderRadius: 27, backgroundColor: brand.white, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 32, fontWeight: '800', lineHeight: 38, letterSpacing: 0.2 },
  body: { fontSize: 17, lineHeight: 24, marginTop: 10 },
  bottom: { paddingHorizontal: 20 },
});
