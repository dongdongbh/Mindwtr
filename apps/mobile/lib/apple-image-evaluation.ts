export const APPLE_IMAGE_LIMITS = {
  maxInputBytes: 12 * 1024 * 1024,
  maxPixelCount: 24_000_000,
  maxDimension: 8_192,
  maxTitleLength: 500,
  maxDescriptionLength: 20_000,
} as const;

export type AppleImageSelection = {
  uri: string;
  width: number;
  height: number;
  inputBytes?: number;
  fileName?: string | null;
};

export type AppleImageProposal = {
  title: string;
  description: string;
};

export type AppleImageProposalSource = 'model' | 'ocr' | 'edited';

export type AppleImageModelAvailability = {
  bridgeAvailable: boolean;
  modelAvailable: boolean;
  reason: 'available' | 'unsupportedPlatform' | 'unsupportedOS' | 'deviceNotEligible'
    | 'appleIntelligenceNotEnabled' | 'modelNotReady' | 'unknown';
};

export type AppleImageNativeResult = {
  modelOutput?: string;
  modelError?: 'unavailable' | 'generationFailed' | 'cancelled';
  ocrText: string;
  inputBytes: number;
  width: number;
  height: number;
  modelDurationMs?: number;
  ocrDurationMs: number;
};

export interface AppleImageNativeBridge {
  getAvailability(): Promise<AppleImageModelAvailability>;
  analyzeImage(operationId: string, uri: string): Promise<AppleImageNativeResult>;
  cancelAnalysis(operationId: string): Promise<void>;
}

export type AppleImageComparison = {
  model: {
    status: 'ready' | 'malformed' | 'unavailable' | 'failed';
    proposal: AppleImageProposal | null;
    durationMs?: number;
  };
  ocr: {
    status: 'ready' | 'empty';
    proposal: AppleImageProposal | null;
    durationMs: number;
  };
  input: Pick<AppleImageNativeResult, 'inputBytes' | 'width' | 'height'>;
};

export type AppleImageEvaluationPhase =
  | 'idle'
  | 'selected'
  | 'analyzing'
  | 'ready'
  | 'saving'
  | 'saveError'
  | 'saved'
  | 'error';

export type AppleImageEvaluationState = {
  phase: AppleImageEvaluationPhase;
  selection: AppleImageSelection | null;
  availability: AppleImageModelAvailability | null;
  comparison: AppleImageComparison | null;
  proposal: AppleImageProposal | null;
  proposalSource: AppleImageProposalSource | null;
  errorCode: 'invalidImage' | 'bridgeUnavailable' | 'analysisFailed' | 'createFailed'
    | 'persistenceFailed' | null;
  saveNeedsFlush: boolean;
  savedTaskId: string | null;
};

export type AppleImageDiagnostic = {
  stage: 'analysis' | 'save';
  outcome: 'completed' | 'cancelled' | 'rejected' | 'failed' | 'persisted';
  kind: 'comparison' | 'task';
};

export type AppleImageSaveDependencies = {
  addTask: (
    title: string,
    initialProps: { status: 'inbox'; description?: string },
    options: { captureId: string },
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
  flushPendingSave: () => Promise<void>;

  retryPendingPersistence: () => Promise<void>;
};

const EMPTY_STATE: AppleImageEvaluationState = {
  phase: 'idle',
  selection: null,
  availability: null,
  comparison: null,
  proposal: null,
  proposalSource: null,
  errorCode: null,
  saveNeedsFlush: false,
  savedTaskId: null,
};

function trimToLimit(value: string, limit: number): string {
  return value.replace(/\r\n/g, '\n').trim().slice(0, limit).trim();
}


export function parseAppleImageModelProposal(raw: string): AppleImageProposal | null {
  let candidate = raw.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.title !== 'string') return null;
  const title = trimToLimit(record.title, APPLE_IMAGE_LIMITS.maxTitleLength);
  if (!title) return null;
  const description = typeof record.description === 'string'
    ? trimToLimit(record.description, APPLE_IMAGE_LIMITS.maxDescriptionLength)
    : '';
  return { title, description };
}

export function buildAppleImageOcrProposal(raw: string): AppleImageProposal | null {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return {
    title: trimToLimit(lines[0], APPLE_IMAGE_LIMITS.maxTitleLength),
    description: trimToLimit(lines.slice(1).join('\n'), APPLE_IMAGE_LIMITS.maxDescriptionLength),
  };
}

export function validateAppleImageSelection(selection: AppleImageSelection): string | null {
  if (!selection.uri.startsWith('file://')) return 'The image must be a local system-selected file.';
  if (!Number.isFinite(selection.width) || !Number.isFinite(selection.height)
    || selection.width <= 0 || selection.height <= 0) {
    return 'The image dimensions are invalid.';
  }
  if (selection.width > APPLE_IMAGE_LIMITS.maxDimension
    || selection.height > APPLE_IMAGE_LIMITS.maxDimension
    || selection.width * selection.height > APPLE_IMAGE_LIMITS.maxPixelCount) {
    return 'The image is too large to analyze safely.';
  }
  if (selection.inputBytes !== undefined
    && (!Number.isFinite(selection.inputBytes) || selection.inputBytes <= 0
      || selection.inputBytes > APPLE_IMAGE_LIMITS.maxInputBytes)) {
    return 'The image file is too large to analyze safely.';
  }
  return null;
}

function buildComparison(result: AppleImageNativeResult): AppleImageComparison {
  const modelProposal = result.modelOutput
    ? parseAppleImageModelProposal(result.modelOutput)
    : null;
  const modelStatus: AppleImageComparison['model']['status'] = modelProposal
    ? 'ready'
    : result.modelError === 'unavailable'
      ? 'unavailable'
      : result.modelError
        ? 'failed'
        : 'malformed';
  const ocrProposal = buildAppleImageOcrProposal(result.ocrText);
  return {
    model: {
      status: modelStatus,
      proposal: modelProposal,
      ...(result.modelDurationMs === undefined ? {} : { durationMs: result.modelDurationMs }),
    },
    ocr: {
      status: ocrProposal ? 'ready' : 'empty',
      proposal: ocrProposal,
      durationMs: result.ocrDurationMs,
    },
    input: {
      inputBytes: result.inputBytes,
      width: result.width,
      height: result.height,
    },
  };
}

export class AppleImageEvaluationController {
  private state: AppleImageEvaluationState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private operationId: string | null = null;
  private captureId: string | null = null;
  private createdTaskId: string | null = null;
  private savePromise: Promise<{ success: boolean; id?: string }> | null = null;

  constructor(
    private readonly bridge: AppleImageNativeBridge,
    private readonly idFactory: () => string,
    private readonly diagnostic?: (event: AppleImageDiagnostic) => void,
  ) {}

  getSnapshot = (): AppleImageEvaluationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(next: AppleImageEvaluationState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  selectImage(selection: AppleImageSelection): string | null {
    if (this.state.phase === 'saving' || this.createdTaskId) {
      return 'Finish saving this task before evaluating another image.';
    }
    const error = validateAppleImageSelection(selection);
    if (error) {
      this.setState({ ...this.state, phase: 'error', errorCode: 'invalidImage' });
      this.diagnostic?.({ stage: 'analysis', outcome: 'rejected', kind: 'comparison' });
      return error;
    }
    this.cancelAnalysis('replacement');
    this.captureId = this.idFactory();
    this.createdTaskId = null;
    this.savePromise = null;
    this.setState({
      ...EMPTY_STATE,
      phase: 'selected',
      selection: { ...selection },
    });
    return null;
  }

  async analyze(): Promise<AppleImageComparison | null> {
    if (!this.state.selection || this.createdTaskId || this.state.phase === 'saving') return null;
    this.cancelAnalysis('replacement');
    const generation = ++this.generation;
    const operationId = this.idFactory();
    this.operationId = operationId;
    const selection = this.state.selection;
    this.setState({ ...this.state, phase: 'analyzing', errorCode: null });

    try {
      const availability = await this.bridge.getAvailability();
      if (generation !== this.generation) return null;
      this.setState({ ...this.state, availability });
      if (!availability.bridgeAvailable) {
        this.setState({ ...this.state, phase: 'error', errorCode: 'bridgeUnavailable' });
        this.diagnostic?.({ stage: 'analysis', outcome: 'failed', kind: 'comparison' });
        return null;
      }

      const result = await this.bridge.analyzeImage(operationId, selection.uri);
      if (generation !== this.generation || this.state.selection?.uri !== selection.uri) return null;
      const comparison = buildComparison(result);
      const preferred = comparison.model.proposal ?? comparison.ocr.proposal;
      if (!preferred) {
        this.setState({
          ...this.state,
          phase: 'error',
          comparison,
          proposal: null,
          proposalSource: null,
          errorCode: 'analysisFailed',
        });
        this.diagnostic?.({ stage: 'analysis', outcome: 'failed', kind: 'comparison' });
        return comparison;
      }
      this.setState({
        ...this.state,
        phase: 'ready',
        comparison,
        proposal: preferred,
        proposalSource: comparison.model.proposal ? 'model' : 'ocr',
        errorCode: null,
      });
      this.diagnostic?.({ stage: 'analysis', outcome: 'completed', kind: 'comparison' });
      return comparison;
    } catch {
      if (generation !== this.generation) return null;
      this.setState({ ...this.state, phase: 'error', errorCode: 'analysisFailed' });
      this.diagnostic?.({ stage: 'analysis', outcome: 'failed', kind: 'comparison' });
      return null;
    } finally {
      if (this.operationId === operationId) this.operationId = null;
    }
  }

  cancelAnalysis(reason: 'background' | 'unmount' | 'replacement' | 'user' = 'user'): void {
    this.generation += 1;
    const operationId = this.operationId;
    this.operationId = null;
    if (operationId) {
      void this.bridge.cancelAnalysis(operationId).catch(() => undefined);
      if (reason !== 'replacement') {
        this.diagnostic?.({ stage: 'analysis', outcome: 'cancelled', kind: 'comparison' });
      }
    }
    if (this.state.phase === 'analyzing') {
      this.setState({
        ...this.state,
        phase: this.state.proposal ? 'ready' : this.state.selection ? 'selected' : 'idle',
        errorCode: null,
      });
    }
  }

  chooseProposal(source: 'model' | 'ocr'): boolean {
    if (this.createdTaskId || this.state.phase === 'saving') return false;
    const proposal = this.state.comparison?.[source].proposal ?? null;
    if (!proposal) return false;
    this.setState({ ...this.state, proposal: { ...proposal }, proposalSource: source, errorCode: null });
    return true;
  }

  updateProposal(patch: Partial<AppleImageProposal>): boolean {
    if (!this.state.proposal || this.createdTaskId || this.state.phase === 'saving') return false;
    const proposal = {
      title: patch.title === undefined ? this.state.proposal.title : patch.title,
      description: patch.description === undefined ? this.state.proposal.description : patch.description,
    };
    this.setState({ ...this.state, proposal, proposalSource: 'edited', errorCode: null });
    return true;
  }

  async save(deps: AppleImageSaveDependencies): Promise<{ success: boolean; id?: string }> {
    if (this.state.phase === 'saved' && this.state.savedTaskId) {
      return { success: true, id: this.state.savedTaskId };
    }
    if (this.savePromise) return this.savePromise;
    const proposal = this.state.proposal;
    const title = proposal ? trimToLimit(proposal.title, APPLE_IMAGE_LIMITS.maxTitleLength) : '';
    if (!proposal || !title || !this.captureId) return { success: false };

    this.setState({ ...this.state, phase: 'saving', errorCode: null });
    this.savePromise = (async () => {
      try {
        if (!this.createdTaskId) {
          const description = trimToLimit(proposal.description, APPLE_IMAGE_LIMITS.maxDescriptionLength);
          const result = await deps.addTask(
            title,
            { status: 'inbox', ...(description ? { description } : {}) },
            { captureId: this.captureId! },
          );
          if (!result.success) {
            this.setState({ ...this.state, phase: 'saveError', errorCode: 'createFailed' });
            this.diagnostic?.({ stage: 'save', outcome: 'failed', kind: 'task' });
            return { success: false };
          }
          this.createdTaskId = result.id ?? this.captureId;
        }

        if (this.state.saveNeedsFlush) {


          await deps.retryPendingPersistence();
        } else {
          await deps.flushPendingSave();
        }
        const savedTaskId = this.createdTaskId;
        this.setState({
          ...this.state,
          phase: 'saved',
          errorCode: null,
          saveNeedsFlush: false,
          savedTaskId,
        });
        this.diagnostic?.({ stage: 'save', outcome: 'persisted', kind: 'task' });
        return { success: true, ...(savedTaskId ? { id: savedTaskId } : {}) };
      } catch {
        this.setState({
          ...this.state,
          phase: 'saveError',
          errorCode: this.createdTaskId ? 'persistenceFailed' : 'createFailed',
          saveNeedsFlush: Boolean(this.createdTaskId),
        });
        this.diagnostic?.({ stage: 'save', outcome: 'failed', kind: 'task' });
        return { success: false };
      } finally {
        this.savePromise = null;
      }
    })();
    return this.savePromise;
  }

  discard(): boolean {
    if (this.state.phase === 'saving' || this.createdTaskId) return false;
    this.cancelAnalysis('user');
    this.captureId = null;
    this.setState(EMPTY_STATE);
    return true;
  }

  startOver(): boolean {
    if (this.state.phase !== 'saved') return false;
    this.captureId = null;
    this.createdTaskId = null;
    this.savePromise = null;
    this.setState(EMPTY_STATE);
    return true;
  }
}
