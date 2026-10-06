import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { brand, useTheme } from '@/theme';

/**
 * A stylised, offline map of Doha-style blocks with an animated courier.
 * Swap for react-native-maps / Mapbox when you connect a real courier feed —
 * only `progress` (0..1 along the route) needs to come from the backend.
 */
const PTS = [
  [0.16, 0.82], [0.16, 0.56], [0.48, 0.56], [0.48, 0.3], [0.84, 0.3], [0.84, 0.16],
] as const;

function usePath(w: number, h: number) {
  return useMemo(() => {
    const pts = PTS.map(([x, y]) => [x * w, y * h] as const);
    const seg: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(d);
      total += d;
    }
    const at = (p: number) => {
      let rem = p * total;
      for (let i = 0; i < seg.length; i++) {
        if (rem <= seg[i] || i === seg.length - 1) {
          const k = seg[i] === 0 ? 0 : Math.min(1, rem / seg[i]);
          return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k };
        }
        rem -= seg[i];
      }
      return { x: pts[0][0], y: pts[0][1] };
    };
    const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
    return { pts, at, d, total };
  }, [w, h]);
}

function Pulse({ x, y, color }: { x: number; y: number; color: string }) {
  const k = useSharedValue(0);
  useEffect(() => { k.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.out(Easing.quad) }), -1, false); }, []);
  const a = useAnimatedStyle(() => ({ opacity: 0.45 * (1 - k.value), transform: [{ scale: 0.6 + k.value * 1.6 }] }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x - 28, top: y - 28, width: 56, height: 56, borderRadius: 28, backgroundColor: color }, a]} />;
}

export function TrackingMap({ width, height, progress, stage }: { width: number; height: number; progress: number; stage: number }) {
  const t = useTheme();
  const { pts, at, d } = usePath(width, height);
  const cx = useSharedValue(at(progress).x);
  const cy = useSharedValue(at(progress).y);
  useEffect(() => {
    const p = at(progress);
    cx.value = withTiming(p.x, { duration: 1900, easing: Easing.linear });
    cy.value = withTiming(p.y, { duration: 1900, easing: Easing.linear });
  }, [progress, at]);
  const courier = useAnimatedStyle(() => ({ transform: [{ translateX: cx.value - 20 }, { translateY: cy.value - 20 }] }));

  const land = t.isDark ? '#1B1613' : '#F1E7D6';
  const block = t.isDark ? '#241D19' : '#FAF3E6';
  const road = t.isDark ? '#3A312B' : '#FFFFFF';
  const water = t.isDark ? '#14263A' : '#C6E0EF';
  const park = t.isDark ? '#17301F' : '#D3E7C8';
  const home = pts[pts.length - 1];
  const shop = pts[0];

  // city blocks grid
  const blocks: React.ReactNode[] = [];
  const cols = 7, rows = 8;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    blocks.push(<Rect key={`${i}-${j}`} x={(i * width) / cols + 5} y={(j * height) / rows + 5} width={width / cols - 10} height={height / rows - 10} rx={8} fill={block} />);
  }

  return (
    <View style={{ width, height, backgroundColor: land, overflow: 'hidden' }}>
      <Svg width={width} height={height}>
        {blocks}
        {/* the Gulf */}
        <Path d={`M${width * 0.62},${height} Q${width * 0.7},${height * 0.82} ${width},${height * 0.76} L${width},${height} Z`} fill={water} />
        <Path d={`M0,0 L${width * 0.3},0 Q${width * 0.22},${height * 0.1} 0,${height * 0.14} Z`} fill={park} />
        {/* avenues */}
        {[0.3, 0.56].map((y) => <Line key={y} x1={0} x2={width} y1={y * height} y2={y * height} stroke={road} strokeWidth={14} />)}
        {[0.16, 0.48, 0.84].map((x) => <Line key={x} y1={0} y2={height} x1={x * width} x2={x * width} stroke={road} strokeWidth={14} />)}
        {/* route */}
        <Path d={d} stroke={t.isDark ? '#4A3F37' : '#E4D8C6'} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <Path d={d} stroke={brand.orange} strokeWidth={4} strokeDasharray="1 9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </Svg>

      {/* store pin */}
      <View style={{ position: 'absolute', left: shop[0] - 20, top: shop[1] - 20, width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } }}>
        <Animated.Text style={{ fontSize: 20 }}>🏪</Animated.Text>
      </View>
      {/* home pin */}
      <Pulse x={home[0]} y={home[1]} color={brand.orange} />
      <View style={{ position: 'absolute', left: home[0] - 20, top: home[1] - 20, width: 40, height: 40, borderRadius: 20, backgroundColor: brand.orange, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#fff' }}>
        <Animated.Text style={{ fontSize: 18 }}>🏠</Animated.Text>
      </View>
      {/* courier */}
      {stage >= 2 && stage < 4 ? (
        <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: 40, height: 40, borderRadius: 20, backgroundColor: brand.ink, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#fff', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } }, courier]}>
          <Animated.Text style={{ fontSize: 20 }}>🛵</Animated.Text>
        </Animated.View>
      ) : null}
    </View>
  );
}
