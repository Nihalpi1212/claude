import React from 'react';
import { I18nManager, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { rise, TAP_IN, TAP_OUT } from '@/lib/motion';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { radius, shadow, type, useTheme } from '@/theme';

export const haptic = {
  light: () => Platform.OS !== 'web' && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  medium: () => Platform.OS !== 'web' && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  select: () => Platform.OS !== 'web' && Haptics.selectionAsync(),
  success: () => Platform.OS !== 'web' && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  error: () => Platform.OS !== 'web' && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
};

type TapProps = {
  children: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  scale?: number;
  disabled?: boolean;
  feedback?: boolean;
  hitSlop?: number;
  accessibilityLabel?: string;
};

/** Pressable with a springy scale — the base of all tappable surfaces. */
export function Tap({ children, onPress, onLongPress, style, scale = 0.96, disabled, feedback = true, hitSlop, accessibilityLabel }: TapProps) {
  const s = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Animated.View style={[a, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        hitSlop={hitSlop ?? 6}
        onPressIn={() => (s.value = withTiming(scale, { duration: TAP_IN }))}
        onPressOut={() => (s.value = withTiming(1, { duration: TAP_OUT }))}
        onPress={() => {
          if (feedback) haptic.light();
          onPress?.();
        }}
        onLongPress={onLongPress}
        style={{ borderRadius: radius.lg }}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

export function Txt({ style, variant = 'body', color, children, ...rest }: React.ComponentProps<typeof Text> & { variant?: keyof typeof type; color?: 'secondary' | 'tertiary' | 'primary' | 'onPrimary' | 'success' | 'danger' }) {
  const t = useTheme();
  const c = color === 'secondary' ? t.textSecondary : color === 'tertiary' ? t.textTertiary : color === 'primary' ? t.primaryText : color === 'onPrimary' ? t.onPrimary : color === 'success' ? t.success : color === 'danger' ? t.danger : t.text;
  return (
    <Text {...rest} style={[type[variant], { color: c }, style]}>
      {children}
    </Text>
  );
}

export function Button({
  title, onPress, variant = 'primary', icon, loading, disabled, style, small,
}: {
  title: string; onPress?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark'; icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; small?: boolean;
}) {
  const t = useTheme();
  const off = disabled || loading;
  const h = small ? 44 : 56; // brand: 44 px minimum height
  const [bg, fg] =
    variant === 'primary' ? [t.primary, t.onPrimary]
    : variant === 'secondary' ? [t.primaryTint, t.text]
    : variant === 'danger' ? [t.fill, t.danger]
    : variant === 'dark' ? [t.isDark ? t.cardAlt : '#201B17', '#FFF8EE']
    : ['transparent', t.primaryText];
  return (
    <Tap onPress={off ? undefined : onPress} style={[{ opacity: off ? 0.45 : 1 }, style]} feedback={!off}>
      <View style={[styles.btn, { height: h, backgroundColor: bg }]}>
        <View style={[styles.btnInner, { height: h }]}>
          {icon ? <Ionicons name={icon} size={20} color={fg} /> : null}
          <Text style={{ color: fg, fontSize: small ? 15 : 17, fontWeight: '800' }}>{loading ? '…' : title}</Text>
        </View>
      </View>
    </Tap>
  );
}

export function Chip({ label, active, onPress, icon }: { label: string; active?: boolean; onPress?: () => void; icon?: keyof typeof Ionicons.glyphMap }) {
  const t = useTheme();
  return (
    <Tap onPress={() => { haptic.select(); onPress?.(); }} scale={0.94} feedback={false}>
      <View style={[styles.chip, { backgroundColor: active ? t.primary : t.card, borderColor: active ? t.primary : t.separator }]}>
        {icon ? <Ionicons name={icon} size={14} color={active ? t.onPrimary : t.textSecondary} /> : null}
        <Text style={{ color: active ? t.onPrimary : t.text, fontWeight: '700', fontSize: 14 }}>{label}</Text>
      </View>
    </Tap>
  );
}

export function Card({ children, style, onPress, delay }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; delay?: number }) {
  const t = useTheme();
  const body = <View style={[{ backgroundColor: t.card, borderRadius: radius.lg, borderCurve: 'continuous' }, shadow(t, 1), style]}>{children}</View>;
  const wrapped = onPress ? <Tap onPress={onPress} scale={0.98}>{body}</Tap> : body;
  return delay !== undefined ? <Animated.View entering={rise(delay)}>{wrapped}</Animated.View> : wrapped;
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.sectionHeader}>
      <Txt variant="title2">{title}</Txt>
      {action ? (
        <Tap onPress={onAction} scale={0.95}>
          <Txt variant="subhead" color="primary" style={{ fontWeight: '600' }}>{action}</Txt>
        </Tap>
      ) : null}
    </View>
  );
}

export function Chevron({ size = 18, color }: { size?: number; color?: string }) {
  const t = useTheme();
  // RN mirrors layout for RTL, but not glyphs
  return <Ionicons name={I18nManager.isRTL ? 'chevron-back' : 'chevron-forward'} size={size} color={color ?? t.textTertiary} />;
}

export function BackGlyph({ color, size = 22 }: { color?: string; size?: number }) {
  const t = useTheme();
  return <Ionicons name={I18nManager.isRTL ? 'arrow-forward' : 'arrow-back'} size={size} color={color ?? t.text} />;
}

/** Flat warm tile with a big emoji. Placeholder for real dish photography (brand: food first, honest portions). */
export function Art({ emoji, size, style, radiusPx = radius.xl }: { emoji: string; colors?: [string, string]; size?: number; style?: StyleProp<ViewStyle>; radiusPx?: number }) {
  const t = useTheme();
  const em = size ? size * 0.5 : 56;
  return (
    <View style={[{ alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: radiusPx, borderCurve: 'continuous', backgroundColor: t.tile }, size ? { width: size, height: size } : null, style]}>
      {/* brand pattern: circles at low opacity */}
      <View style={{ position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 10, borderColor: 'rgba(253,137,18,0.14)', top: -34, end: -26 }} />
      <View style={{ position: 'absolute', width: 70, height: 70, borderRadius: 35, borderWidth: 8, borderColor: 'rgba(253,137,18,0.10)', bottom: -22, start: -14 }} />
      <Text style={{ fontSize: em }}>{emoji}</Text>
    </View>
  );
}

export function Stepper({ qty, onChange, min = 0, small }: { qty: number; onChange: (n: number) => void; min?: number; small?: boolean }) {
  const t = useTheme();
  const d = small ? 32 : 36;
  const btn = (name: keyof typeof Ionicons.glyphMap, delta: number, danger?: boolean) => (
    <Tap onPress={() => { haptic.select(); onChange(Math.max(min, qty + delta)); }} scale={0.85} feedback={false}>
      <View style={{ width: d, height: d, borderRadius: d / 2, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={name} size={small ? 16 : 18} color={danger ? t.danger : t.text} />
      </View>
    </Tap>
  );
  return (
    <View style={[styles.stepper, { backgroundColor: t.primaryTint, height: d + 2 }]}>
      {btn(qty <= 1 && min === 0 ? 'trash-outline' : 'remove', -1, qty <= 1 && min === 0)}
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 16, minWidth: 22, textAlign: 'center' }}>{qty}</Text>
      {btn('add', 1)}
    </View>
  );
}

export function Stars({ value, size = 14 }: { value: number; size?: number }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      <Ionicons name="star" size={size} color={t.star} />
      <Text style={{ color: t.text, fontWeight: '700', fontSize: size }}>{value.toFixed(1)}</Text>
    </View>
  );
}

export function Badge({ text, tone = 'primary', icon }: { text: string; tone?: 'primary' | 'success' | 'warning' | 'neutral'; icon?: keyof typeof Ionicons.glyphMap }) {
  const t = useTheme();
  const map = {
    primary: [t.primaryTint, t.text], success: [t.successTint, t.success], warning: [t.warningTint, t.warning], neutral: [t.fill, t.textSecondary],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      {icon ? <Ionicons name={icon} size={12} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

export function Row({ icon, title, subtitle, value, onPress, right, tint, last, destructive }: {
  icon?: keyof typeof Ionicons.glyphMap; title: string; subtitle?: string; value?: string; onPress?: () => void; right?: React.ReactNode; tint?: string; last?: boolean; destructive?: boolean;
}) {
  const t = useTheme();
  const body = (
    <View style={styles.row}>
      {icon ? (
        <View style={[styles.rowIcon, { backgroundColor: (tint ?? t.primary) + '26' }]}>
          <Ionicons name={icon} size={19} color={tint ?? t.primaryText} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Txt variant="callout" style={{ fontWeight: '600', color: destructive ? t.danger : t.text }}>{title}</Txt>
        {subtitle ? <Txt variant="footnote" color="secondary" style={{ marginTop: 2 }}>{subtitle}</Txt> : null}
      </View>
      {value ? <Txt variant="subhead" color="secondary">{value}</Txt> : null}
      {right ?? (onPress ? <Chevron /> : null)}
    </View>
  );
  return (
    <View>
      {onPress ? <Tap onPress={onPress} scale={0.985}>{body}</Tap> : body}
      {!last ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator, marginStart: icon ? 62 : 16 }} /> : null}
    </View>
  );
}

export function Empty({ emoji, title, body, action, onAction }: { emoji: string; title: string; body: string; action?: string; onAction?: () => void }) {
  return (
    <Animated.View entering={rise()} style={{ alignItems: 'center', paddingVertical: 56, paddingHorizontal: 32, gap: 8 }}>
      <Text style={{ fontSize: 64 }}>{emoji}</Text>
      <Txt variant="title3" style={{ textAlign: 'center' }}>{title}</Txt>
      <Txt variant="subhead" color="secondary" style={{ textAlign: 'center' }}>{body}</Txt>
      {action ? <Button title={action} onPress={onAction} small style={{ marginTop: 16, alignSelf: 'stretch' }} /> : null}
    </Animated.View>
  );
}

export function GlassCircle({ children, onPress, size = 40 }: { children: React.ReactNode; onPress?: () => void; size?: number }) {
  const t = useTheme();
  return (
    <Tap onPress={onPress} scale={0.9}>
      <View style={[{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: t.isDark ? 'rgba(32,27,23,0.9)' : 'rgba(255,255,255,0.95)' }, shadow(t, 1)]}>{children}</View>
    </Tap>
  );
}

const styles = StyleSheet.create({
  btn: { borderRadius: radius.md, borderCurve: 'continuous', overflow: 'hidden', justifyContent: 'center' },
  btnInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 40, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, marginTop: 28, marginBottom: 12 },
  stepper: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.pill, paddingHorizontal: 2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 24, borderRadius: radius.pill, alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
});
