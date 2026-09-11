import type { Task } from './types';

type IndexedTask = {
    readonly bigrams: ReadonlySet<string>;
    readonly normalizedTitle: string;
    readonly operatorSensitive: boolean;
    readonly task: Task;
    readonly words: ReadonlySet<string>;
};

/** In-memory title index; consumers should treat its posting lists as opaque. */
export interface TaskSimilarityIndex {
    readonly bigramPostings: ReadonlyMap<string, readonly IndexedTask[]>;
    readonly exactTitles: ReadonlyMap<string, readonly IndexedTask[]>;
    readonly wordPostings: ReadonlyMap<string, readonly IndexedTask[]>;
}

const LATIN_CHARACTER = /\p{Script=Latin}/u;
const MARK_CHARACTER = /\p{M}/u;
const COMPACT_SCRIPT_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const OPERATOR_SENSITIVE_TITLE = /[\p{L}\p{N}][+&#|*=<>^~%]/u;

// Fold familiar Latin accents for forgiving matching without erasing marks
// that distinguish letters and vowels in other writing systems.
const foldLatinDiacritics = (title: string): string => {
    let folded = '';
    let followsLatinCharacter = false;
    for (const character of title.normalize('NFKD')) {
        if (MARK_CHARACTER.test(character)) {
            if (!followsLatinCharacter) folded += character;
            continue;
        }
        folded += character;
        followsLatinCharacter = LATIN_CHARACTER.test(character);
    }
    return folded.normalize('NFC').toLowerCase();
};

const normalizeComparableTitle = (title: string): string => foldLatinDiacritics(title)
    .trim()
    .replace(/\s+/g, ' ');

const normalizeTitleWords = (title: string): string => foldLatinDiacritics(title)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const compareIndexedTasks = (left: IndexedTask, right: IndexedTask): number => {
    if (left.normalizedTitle !== right.normalizedTitle) {
        return left.normalizedTitle < right.normalizedTitle ? -1 : 1;
    }
    if (left.task.id === right.task.id) return 0;
    return left.task.id < right.task.id ? -1 : 1;
};

const getUnicodeBigrams = (words: ReadonlySet<string>): Set<string> => {
    const bigrams = new Set<string>();
    for (const word of words) {
        const characters = Array.from(word);
        for (let index = 0; index < characters.length - 1; index += 1) {
            if (!COMPACT_SCRIPT_CHARACTER.test(characters[index])
                || !COMPACT_SCRIPT_CHARACTER.test(characters[index + 1])) {
                continue;
            }
            bigrams.add(`${characters[index]}${characters[index + 1]}`);
        }
    }
    return bigrams;
};

/** Build a read-only snapshot index over the supplied task objects. */
export function createTaskSimilarityIndex(tasks: readonly Task[]): TaskSimilarityIndex {
    const exactTitles = new Map<string, IndexedTask[]>();
    const wordPostings = new Map<string, IndexedTask[]>();
    const bigramPostings = new Map<string, IndexedTask[]>();
    for (const task of tasks) {
        if (task.deletedAt || task.purgedAt) continue;
        const normalizedTitle = normalizeComparableTitle(task.title);
        const normalizedWords = normalizeTitleWords(task.title);
        if (!normalizedWords) continue;
        const words = new Set(normalizedWords.split(' '));
        const bigrams = getUnicodeBigrams(words);
        const entry = {
            bigrams,
            normalizedTitle,
            operatorSensitive: OPERATOR_SENSITIVE_TITLE.test(normalizedTitle),
            task,
            words,
        };
        const matches = exactTitles.get(normalizedTitle);
        if (matches) matches.push(entry);
        else exactTitles.set(normalizedTitle, [entry]);
        for (const word of words) {
            const postings = wordPostings.get(word);
            if (postings) postings.push(entry);
            else wordPostings.set(word, [entry]);
        }
        for (const bigram of bigrams) {
            const postings = bigramPostings.get(bigram);
            if (postings) postings.push(entry);
            else bigramPostings.set(bigram, [entry]);
        }
    }
    for (const matches of exactTitles.values()) matches.sort(compareIndexedTasks);
    return { bigramPostings, exactTitles, wordPostings };
}

/**
 * Return at most three conservative title matches, strongest first.
 * Matching is pure: it neither updates tasks nor refreshes the supplied index.
 */
export function findSimilarTasks(
    index: TaskSimilarityIndex,
    title: string,
    excludeTaskId: string,
): Task[] {
    const normalizedTitle = normalizeComparableTitle(title);
    const normalizedWords = normalizeTitleWords(title);
    if (!normalizedWords) return [];
    const queryWords = new Set(normalizedWords.split(' '));
    const queryBigrams = getUnicodeBigrams(queryWords);
    const operatorSensitive = OPERATOR_SENSITIVE_TITLE.test(normalizedTitle);
    const candidates = new Set<IndexedTask>();
    for (const match of index.exactTitles.get(normalizedTitle) ?? []) candidates.add(match);
    if (!operatorSensitive) {
        for (const word of queryWords) {
            for (const match of index.wordPostings.get(word) ?? []) candidates.add(match);
        }
        for (const bigram of queryBigrams) {
            for (const match of index.bigramPostings.get(bigram) ?? []) candidates.add(match);
        }
    }

    return [...candidates]
        .filter(({ task }) => task.id !== excludeTaskId)
        .map((entry) => {
            if (entry.normalizedTitle === normalizedTitle) return { entry, score: 2 };
            if (operatorSensitive || entry.operatorSensitive) return null;
            let sharedWords = 0;
            for (const word of queryWords) {
                if (entry.words.has(word)) sharedWords += 1;
            }
            const maxWords = Math.max(queryWords.size, entry.words.size);
            const minWords = Math.min(queryWords.size, entry.words.size);
            // Two coincidental words in a long title are noise; require most of
            // the longer title to overlap before treating it as a near match.
            const wordScore = sharedWords >= 2 && sharedWords / maxWords >= 0.6
                ? (sharedWords / maxWords) + ((sharedWords / minWords) * 0.1)
                : 0;
            let sharedBigrams = 0;
            for (const bigram of queryBigrams) {
                if (entry.bigrams.has(bigram)) sharedBigrams += 1;
            }
            const minBigrams = Math.min(queryBigrams.size, entry.bigrams.size);
            const maxBigrams = Math.max(queryBigrams.size, entry.bigrams.size);
            const bigramDice = (sharedBigrams * 2) / (queryBigrams.size + entry.bigrams.size);
            const bigramScore = sharedBigrams >= 2
                && minBigrams > 0
                && sharedBigrams / minBigrams >= 0.6
                && bigramDice >= 0.45
                ? (sharedBigrams / maxBigrams) + ((sharedBigrams / minBigrams) * 0.1)
                : 0;
            const score = Math.max(wordScore, bigramScore);
            if (score === 0) return null;
            return {
                entry,
                score,
            };
        })
        .filter((result): result is { entry: IndexedTask; score: number } => result !== null)
        .sort((left, right) => (right.score - left.score) || compareIndexedTasks(left.entry, right.entry))
        .slice(0, 3)
        .map(({ entry }) => entry.task);
}
