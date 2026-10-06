import React from 'react';
import { Image, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { brand } from '@/theme';

/**
 * Kaser master logo — supplied artwork, used unmodified on light backgrounds.
 * (Brand book: min 48 px, preferred 80 px+, clear space = 10% of width, never recolour/crop.)
 * Replace assets/kaser-logo.png with the approved vector/transparent master when available.
 */
export function KaserLogo({ size = 96, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  const s = Math.max(48, size);
  return (
    <View style={[{ width: s, height: s }, style]} accessibilityRole="image" accessibilityLabel="Kaser كاسر">
      <Image source={require('../../assets/kaser-logo.png')} style={{ width: s, height: s }} resizeMode="contain" />
    </View>
  );
}

/** Brand pattern: a field of ring outlines. Use at 10–25% opacity on large surfaces only. */
export function RingPattern({ width, height, color = brand.ink, opacity = 0.14, gap = 44, r = 13 }: { width: number; height: number; color?: string; opacity?: number; gap?: number; r?: number }) {
  const cols = Math.ceil(width / gap) + 1;
  const rows = Math.ceil(height / gap) + 1;
  const dots: React.ReactNode[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++)
      dots.push(<Circle key={`${i}-${j}`} cx={i * gap + (j % 2 ? gap / 2 : 0)} cy={j * gap} r={r} stroke={color} strokeWidth={4} fill="none" />);
  return (
    <Svg width={width} height={height} style={{ position: 'absolute', opacity }} pointerEvents="none">
      {dots}
    </Svg>
  );
}
