import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  keyboardAvoiding: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  recordButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  recordingText: {
    fontSize: 12,
    fontWeight: '600',
  },
  optionsRow: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  optionText: {
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 120,
  },
  footerRow: {
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toggleText: {
    fontSize: 12,
    fontWeight: '600',
  },
  saveButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
  },
  saveText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  overlayBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  pickerCard: {
    width: '100%',
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  pickerTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  pickerInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  pickerList: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 10,
    maxHeight: 220,
  },
  pickerListContent: {
    paddingVertical: 6,
  },
  pickerRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickerRowText: {
    fontSize: 14,
    fontWeight: '600',
  },
  selectedContextWrap: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  selectedContextChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  selectedContextChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
