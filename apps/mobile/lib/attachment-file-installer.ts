import AttachmentFileInstaller from '../modules/attachment-file-installer';

export type AttachmentFileExpectedGeneration =
  | { kind: 'absent' }
  | { kind: 'present'; sha256: string };

export type AttachmentFileInstallResult =
  | { status: 'installed'; preservedPath?: string }
  | { status: 'conflict'; preservedPath: string };

type NativeAttachmentFileInstaller = {
  installAsync(
    stagedPath: string,
    targetPath: string,
    expected: { kind: 'absent' } | { kind: 'present'; sha256: string },
    expectedDownloadSha256: string,
  ): Promise<unknown>;
};

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const assertPath = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
};

const parseNativeResult = (value: unknown): AttachmentFileInstallResult => {
  if (!value || typeof value !== 'object') {
    throw new Error('Attachment file installer returned an invalid result');
  }
  const result = value as Record<string, unknown>;
  if (result.status === 'installed') {
    return typeof result.preservedPath === 'string' && result.preservedPath.trim()
      ? { status: 'installed', preservedPath: result.preservedPath }
      : { status: 'installed' };
  }
  if (
    result.status === 'conflict'
    && typeof result.preservedPath === 'string'
    && result.preservedPath.trim()
  ) {
    return { status: 'conflict', preservedPath: result.preservedPath };
  }
  throw new Error('Attachment file installer returned an invalid result');
};

export const installAttachmentFileGeneration = async (
  stagedPath: string,
  targetPath: string,
  expected: AttachmentFileExpectedGeneration,
  expectedDownloadSha256: string,
): Promise<AttachmentFileInstallResult> => {
  const normalizedStagedPath = assertPath(stagedPath, 'Staged attachment path');
  const normalizedTargetPath = assertPath(targetPath, 'Target attachment path');
  const normalizedExpected = expected.kind === 'present'
    ? { kind: 'present' as const, sha256: expected.sha256.trim().toLowerCase() }
    : { kind: 'absent' as const };
  if (normalizedExpected.kind === 'present' && !SHA256_HEX_PATTERN.test(normalizedExpected.sha256)) {
    throw new Error('Expected attachment SHA-256 must be 64 lowercase hexadecimal characters');
  }
  const normalizedDownloadSha256 = expectedDownloadSha256.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalizedDownloadSha256)) {
    throw new Error('Expected download SHA-256 must be 64 lowercase hexadecimal characters');
  }

  const result = await (AttachmentFileInstaller as NativeAttachmentFileInstaller).installAsync(
    normalizedStagedPath,
    normalizedTargetPath,
    normalizedExpected,
    normalizedDownloadSha256,
  );
  return parseNativeResult(result);
};
