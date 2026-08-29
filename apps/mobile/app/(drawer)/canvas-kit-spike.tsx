import { useMemo, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Group, Layer, Rect, Stage, Text as CanvasText } from 'react-native-canvas-kit';

const CARD_W = 142;
const CARD_H = 76;
const AREAS = [
  { name: 'Work', color: '#dbeafe', x: 24, y: 28 },
  { name: 'Personal', color: '#dcfce7', x: 24, y: 360 },
  { name: 'Someday', color: '#fef3c7', x: 520, y: 28 },
];

export default function CanvasKitSpikeScreen() {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const { width, height } = Dimensions.get('window');
  const scene = useMemo(() => AREAS.flatMap((area, areaIndex) => (
    Array.from({ length: 8 }, (_, index) => ({
      id: `${area.name}-${index + 1}`,
      title: `${area.name} project ${index + 1}`,
      x: area.x + (index % 2) * 180,
      y: area.y + Math.floor(index / 2) * 92,
      area: area.name,
    }))
  )), []);

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ Projects</Text>
        </Pressable>
        <Text style={styles.title}>Canvas Kit spike · {scene.length} cards</Text>
        <Text style={styles.hint}>{selected ? `Selected: ${selected}` : 'Drag cards · pinch · pan · tap'}</Text>
      </View>
      <View style={styles.viewport}>
        <Stage width={width} height={Math.max(height - 132, 320)} style={styles.stage} pinchSensitivity={1}>
          <Layer>
            {AREAS.map((area) => (
              <Group key={area.name} x={area.x - 12} y={area.y - 16}>
                <Rect width={390} height={300} fill={area.color} cornerRadius={18} opacity={0.72} />
                <CanvasText x={18} y={30} text={area.name} fontSize={18} fill="#172033" fontStyle="bold" />
              </Group>
            ))}
            {scene.map((card) => (
              <Group key={card.id} x={card.x} y={card.y} draggable onTap={() => setSelected(card.id)}>
                <Rect width={CARD_W} height={CARD_H} fill={selected === card.id ? '#2563eb' : '#ffffff'} stroke="#94a3b8" strokeWidth={2} cornerRadius={12} />
                <CanvasText x={12} y={29} text={card.title} fontSize={14} fill={selected === card.id ? '#ffffff' : '#172033'} />
                <CanvasText x={12} y={52} text="tap / drag" fontSize={11} fill={selected === card.id ? '#dbeafe' : '#64748b'} />
              </Group>
            ))}
          </Layer>
        </Stage>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f8fafc' },
  toolbar: { minHeight: 80, paddingHorizontal: 16, paddingTop: 12, justifyContent: 'center', gap: 4 },
  back: { alignSelf: 'flex-start', paddingVertical: 4 },
  backText: { color: '#2563eb', fontSize: 16 },
  title: { color: '#172033', fontSize: 18, fontWeight: '700' },
  hint: { color: '#64748b', fontSize: 12 },
  viewport: { flex: 1, overflow: 'hidden', borderTopWidth: 1, borderColor: '#cbd5e1' },
  stage: { backgroundColor: '#eef2ff' },
});
