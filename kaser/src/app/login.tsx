import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Tap, Txt, haptic } from '@/components/ui';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { formatPhone, validQatarMobile } from '@/lib/format';
import { brand, radius, useTheme } from '@/theme';

const DEMO_CODE = '1234';

export default function Login() {
  const t = useTheme();
  const { t: tr } = useT();
  const insets = useSafeAreaInsets();
  const signIn = useStore((s) => s.signIn);
  const guest = useStore((s) => s.continueAsGuest);
  const [step, setStep] = useState<'phone' | 'otp' | 'name'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [secs, setSecs] = useState(30);
  const codeRef = useRef<TextInput>(null);
  const shake = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  useEffect(() => {
    if (step !== 'otp') return;
    setSecs(30);
    const id = setInterval(() => setSecs((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [step]);

  const sendCode = () => {
    if (!validQatarMobile(phone)) {
      setError(tr('invalidPhone'));
      haptic.error();
      return;
    }
    setError('');
    setStep('otp');
    setTimeout(() => codeRef.current?.focus(), 350);
  };

  const onCode = (v: string) => {
    const c = v.replace(/\D/g, '').slice(0, 4);
    setCode(c);
    setError('');
    if (c.length === 4) {
      if (c === DEMO_CODE) {
        haptic.success();
        setStep('name');
      } else {
        haptic.error();
        setError(tr('wrongCode'));
        shake.value = withSequence(withTiming(-10, { duration: 50 }), withTiming(10, { duration: 80 }), withTiming(-8, { duration: 80 }), withTiming(0, { duration: 50 }));
        setTimeout(() => setCode(''), 300);
      }
    }
  };

  const finish = () => {
    signIn({ name: name.trim() || 'Kaser Guest', phone });
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <LinearGradient colors={[brand.maroonLight, brand.maroon, brand.maroonDeep]} style={[styles.hero, { paddingTop: insets.top + 30 }]}>
        <Animated.View entering={FadeIn.duration(500)} style={styles.logoBox}>
          <Text style={styles.logoK}>K</Text>
        </Animated.View>
        <Text style={styles.brand}>{tr('appName')}</Text>
        <Text style={styles.tag}>{tr('tagline')}</Text>
      </LinearGradient>

      <View style={[styles.sheet, { backgroundColor: t.bg }]}>
        {step === 'phone' && (
          <Animated.View key="p" entering={FadeInDown.springify().damping(18)} exiting={FadeOut.duration(120)} style={{ gap: 14 }}>
            <Txt variant="title1">{tr('welcome')}</Txt>
            <Txt variant="subhead" color="secondary">{tr('enterPhone')}</Txt>
            <View style={[styles.phoneRow, { backgroundColor: t.card, borderColor: error ? t.danger : t.separator }]}>
              <Text style={{ fontSize: 22 }}>🇶🇦</Text>
              <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>+974</Text>
              <View style={{ width: 1, height: 24, backgroundColor: t.separator }} />
              <TextInput
                value={phone}
                onChangeText={(v) => { setPhone(v.replace(/\D/g, '').slice(0, 8)); setError(''); }}
                keyboardType="number-pad"
                placeholder="5555 1234"
                placeholderTextColor={t.textTertiary}
                style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '600', letterSpacing: 1, textAlign: 'left' }}
                autoFocus
                maxLength={8}
                onSubmitEditing={sendCode}
              />
            </View>
            {error ? <Txt variant="footnote" color="danger">{error}</Txt> : null}
            <Button title={tr('continue')} onPress={sendCode} disabled={phone.length < 8} />
            <Tap onPress={() => guest()}>
              <Txt variant="callout" color="primary" style={{ textAlign: 'center', fontWeight: '600', paddingVertical: 6 }}>{tr('guest')}</Txt>
            </Tap>
            <Txt variant="caption" color="tertiary" style={{ textAlign: 'center' }}>{tr('terms')}</Txt>
          </Animated.View>
        )}

        {step === 'otp' && (
          <Animated.View key="o" entering={FadeInDown.springify().damping(18)} exiting={FadeOut.duration(120)} style={{ gap: 14 }}>
            <Txt variant="title1">{tr('enterCode')}</Txt>
            <Txt variant="subhead" color="secondary">{tr('codeSent', { phone: formatPhone(phone) })}</Txt>
            <Animated.View style={[{ flexDirection: 'row', gap: 12, justifyContent: 'center', marginVertical: 8 }, shakeStyle]}>
              {[0, 1, 2, 3].map((k) => (
                <View key={k} style={[styles.otpBox, { backgroundColor: t.card, borderColor: error ? t.danger : code.length === k ? t.primary : t.separator, borderWidth: code.length === k ? 2 : 1 }]}>
                  <Text style={{ color: t.text, fontSize: 28, fontWeight: '800' }}>{code[k] ?? ''}</Text>
                </View>
              ))}
            </Animated.View>
            <TextInput ref={codeRef} value={code} onChangeText={onCode} keyboardType="number-pad" maxLength={4} style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }} textContentType="oneTimeCode" autoComplete="sms-otp" />
            {error ? <Txt variant="footnote" color="danger" style={{ textAlign: 'center' }}>{error}</Txt> : <Txt variant="footnote" color="tertiary" style={{ textAlign: 'center' }}>{tr('demoCode')}</Txt>}
            <Tap onPress={secs === 0 ? () => setSecs(30) : undefined} feedback={secs === 0}>
              <Txt variant="callout" color={secs === 0 ? 'primary' : 'tertiary'} style={{ textAlign: 'center', fontWeight: '600', paddingVertical: 8 }}>
                {secs === 0 ? tr('resend') : tr('resendIn', { s: secs })}
              </Txt>
            </Tap>
            <Tap onPress={() => { setStep('phone'); setCode(''); }}>
              <Txt variant="footnote" color="secondary" style={{ textAlign: 'center' }}>{formatPhone(phone)} ✎</Txt>
            </Tap>
          </Animated.View>
        )}

        {step === 'name' && (
          <Animated.View key="n" entering={FadeInDown.springify().damping(18)} style={{ gap: 14 }}>
            <Txt variant="title1">{tr('yourName')}</Txt>
            <View style={[styles.phoneRow, { backgroundColor: t.card, borderColor: t.separator }]}>
              <TextInput value={name} onChangeText={setName} placeholder="Mohammed Al Thani" placeholderTextColor={t.textTertiary} style={{ flex: 1, color: t.text, fontSize: 18, fontWeight: '600' }} autoFocus autoCapitalize="words" onSubmitEditing={finish} />
            </View>
            <Button title={tr('continue')} onPress={finish} />
          </Animated.View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingBottom: 44, borderBottomStartRadius: 36, borderBottomEndRadius: 36 },
  logoBox: { width: 84, height: 84, borderRadius: 26, borderCurve: 'continuous', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 20, shadowOffset: { width: 0, height: 10 } },
  logoK: { color: brand.maroon, fontSize: 54, fontWeight: '900' },
  brand: { color: '#fff', fontSize: 34, fontWeight: '900', marginTop: 14, letterSpacing: 0.5 },
  tag: { color: 'rgba(255,255,255,0.8)', fontSize: 15, marginTop: 4 },
  sheet: { flex: 1, padding: 24, paddingTop: 28 },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, height: 62, borderRadius: radius.lg, borderCurve: 'continuous', borderWidth: 1 },
  otpBox: { width: 64, height: 72, borderRadius: 18, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
});
