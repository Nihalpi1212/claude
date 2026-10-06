import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeInRight, FadeInLeft, FadeOutLeft, FadeOutRight, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming, Easing, ZoomIn,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tap, haptic } from '@/components/ui';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { brand } from '@/theme';

const SLIDES = [
  { hero: '🍛', orbit: ['🥗', '🍔', '☕', '🍕'], t: 'ob1Title', b: 'ob1Body' },
  { hero: '🛵', orbit: ['📍', '⚡', '🕐', '🌯'], t: 'ob2Title', b: 'ob2Body' },
  { hero: '🎁', orbit: ['💳', '⭐', '🧡', '🛍️'], t: 'ob3Title', b: 'ob3Body' },
] as const;

function Float({ children, delay = 0, amp = 10, style }: { children: React.ReactNode; delay?: number; amp?: number; style?: any }) {
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withRepeat(withSequence(withTiming(-amp, { duration: 1800 + delay, easing: Easing.inOut(Easing.sin) }), withTiming(amp, { duration: 1800 + delay, easing: Easing.inOut(Easing.sin) })), -1, true);
  }, []);
  const a = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  return <Animated.View style={[a, style]}>{children}</Animated.View>;
}

function Dot({ active }: { active: boolean }) {
  const a = useAnimatedStyle(() => ({ width: withSpring(active ? 28 : 8, { damping: 16 }), opacity: withTiming(active ? 1 : 0.4) }));
  return <Animated.View style={[{ height: 8, borderRadius: 4, backgroundColor: '#fff' }, a]} />;
}

export default function Onboarding() {
  const { t, lang, isRTL } = useT();
  const insets = useSafeAreaInsets();
  const setLang = useStore((s) => s.setLang);
  const finish = useStore((s) => s.finishOnboarding);
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);
  const last = i === SLIDES.length - 1;

  const go = (n: number) => {
    if (n < 0 || n >= SLIDES.length) return;
    setDir(n > i ? 1 : -1);
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
      const swipeNext = isRTL ? e.translationX > 50 : e.translationX < -50;
      const swipePrev = isRTL ? e.translationX < -50 : e.translationX > 50;
      if (swipeNext) go(i + 1);
      else if (swipePrev) go(i - 1);
    });

  const s = SLIDES[i];
  const enter = (dir > 0) !== isRTL ? FadeInRight : FadeInLeft;
  const exit = (dir > 0) !== isRTL ? FadeOutLeft : FadeOutRight;

  return (
    <LinearGradient colors={[brand.maroonLight, brand.maroon, brand.maroonDeep]} style={{ flex: 1 }}>
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Tap onPress={() => setLang(lang === 'en' ? 'ar' : 'en')} scale={0.92}>
          <View style={styles.langPill}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{lang === 'en' ? 'العربية' : 'English'}</Text>
          </View>
        </Tap>
        {!last ? (
          <Tap onPress={done} scale={0.92}>
            <Text style={{ color: 'rgba(255,255,255,0.85)', fontWeight: '600', fontSize: 16, padding: 8 }}>{t('skip')}</Text>
          </Tap>
        ) : <View />}
      </View>

      <GestureDetector gesture={pan}>
        <View style={{ flex: 1 }}>
          <Animated.View key={i} entering={enter.springify().damping(18)} exiting={exit.duration(160)} style={styles.slide}>
            <View style={styles.heroWrap}>
              <View style={styles.ring1} />
              <View style={styles.ring2} />
              <Float amp={8}>
                <Animated.View entering={ZoomIn.springify().damping(12)} style={styles.heroCircle}>
                  <Text style={{ fontSize: 96 }}>{s.hero}</Text>
                </Animated.View>
              </Float>
              {s.orbit.map((e, k) => {
                const pos = [{ top: 6, start: 8 }, { top: 40, end: 0 }, { bottom: 24, start: 0 }, { bottom: 0, end: 24 }][k];
                return (
                  <Float key={k} delay={k * 250} amp={6 + k * 2} style={[styles.orbit, pos]}>
                    <View style={styles.orbitBubble}><Text style={{ fontSize: 28 }}>{e}</Text></View>
                  </Float>
                );
              })}
            </View>
            <Text style={styles.title}>{t(s.t)}</Text>
            <Text style={styles.body}>{t(s.b)}</Text>
          </Animated.View>
        </View>
      </GestureDetector>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 20 }]}>
        <View style={{ flexDirection: 'row', gap: 6, alignSelf: 'center', marginBottom: 24 }}>
          {SLIDES.map((_, k) => <Dot key={k} active={k === i} />)}
        </View>
        <Tap onPress={() => (last ? done() : go(i + 1))} scale={0.97}>
          <View style={styles.cta}>
            <Text style={{ color: brand.maroon, fontSize: 17, fontWeight: '800' }}>{last ? t('getStarted') : t('next')}</Text>
          </View>
        </Tap>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20 },
  langPill: { paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  slide: { flex: 1, paddingHorizontal: 28, justifyContent: 'center' },
  heroWrap: { height: 300, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  ring1: { position: 'absolute', width: 290, height: 290, borderRadius: 145, backgroundColor: 'rgba(255,255,255,0.07)' },
  ring2: { position: 'absolute', width: 220, height: 220, borderRadius: 110, backgroundColor: 'rgba(255,255,255,0.09)' },
  heroCircle: { width: 168, height: 168, borderRadius: 84, backgroundColor: 'rgba(255,255,255,0.95)', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 30, shadowOffset: { width: 0, height: 16 } },
  orbit: { position: 'absolute' },
  orbitBubble: { width: 58, height: 58, borderRadius: 29, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 32, fontWeight: '800', lineHeight: 38, letterSpacing: 0.3, textAlign: 'center' },
  body: { color: 'rgba(255,255,255,0.82)', fontSize: 17, lineHeight: 24, textAlign: 'center', marginTop: 12 },
  bottom: { paddingHorizontal: 24 },
  cta: { height: 58, borderRadius: 20, borderCurve: 'continuous', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
});
